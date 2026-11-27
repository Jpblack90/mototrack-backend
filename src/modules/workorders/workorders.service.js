import pool from '../../config/database.js';
import { logAudit } from '../../shared/audit.js';
import { normalizePhonePE } from '../../shared/utils/phonePE.js';
import { buildWhatsAppMessage, WHATSAPP_EVENTS } from './whatsappTemplates.js';

// ─── Errores controlados ──────────────────────────────────────────────────────

class AppError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ─── Constantes del dominio ───────────────────────────────────────────────────

/**
 * Mapa de transiciones válidas de la máquina de estados de una OT.
 * Clave: estado actual. Valor: array de estados destino permitidos.
 */
export const VALID_TRANSITIONS = {
  recibido:              ['diagnostico'],
  diagnostico:           ['en_reparacion', 'pendiente_aprobacion'],
  pendiente_aprobacion:  ['en_reparacion', 'entregado'],
  en_reparacion:         ['terminado'],
  terminado:             ['entregado', 'no_recogido'],
  entregado:             [],
  no_recogido:           ['entregado'],
};

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Obtiene el nombre comercial o razón social de la empresa para usar como {taller}.
 */
async function getCompanyName(companyId, clientOrPool = pool) {
  const { rows } = await clientOrPool.query(
    'SELECT nombre_comercial, razon_social FROM companies WHERE id = $1',
    [companyId]
  );
  if (!rows[0]) return '';
  return (rows[0].nombre_comercial || rows[0].razon_social || '').trim();
}

/**
 * Crea una notificación pendiente para WhatsApp si el cliente dio su consentimiento (whatsapp_opt_in)
 * y cuenta con un celular peruano válido (RF-15 / Fase 1).
 */
async function createWhatsAppNoticeIfEligible({
  workOrderId,
  companyId,
  event,
  params = {},
  vehicle = null,
  clientOrPool = pool,
}) {
  let veh = vehicle;
  if (!veh) {
    const { rows } = await clientOrPool.query(
      `SELECT v.id, v.placa, v.customer_name, v.customer_phone, v.whatsapp_opt_in
       FROM work_orders wo
       JOIN vehicles v ON v.id = wo.vehicle_id
       WHERE wo.id = $1 AND wo.company_id = $2`,
      [workOrderId, companyId]
    );
    veh = rows[0];
  }

  if (!veh || !veh.whatsapp_opt_in) return null;

  const normalizedPhone = normalizePhonePE(veh.customer_phone);
  if (!normalizedPhone) return null;

  const taller = params.taller || (await getCompanyName(companyId, clientOrPool));
  const message = buildWhatsAppMessage(event, {
    cliente: params.cliente || veh.customer_name,
    placa: params.placa || veh.placa,
    taller,
    monto: params.monto,
    dias: params.dias,
  });

  if (!message) return null;

  const { rows: inserted } = await clientOrPool.query(
    `INSERT INTO notifications (company_id, work_order_id, message, channel, status, event)
     VALUES ($1, $2, $3, 'whatsapp', 'pending', $4)
     RETURNING *`,
    [companyId, workOrderId, message, event]
  );

  return inserted[0];
}

/**
 * Stub de notificación al cliente (mantenido para logging/retrocompatibilidad).
 */
async function notifyClient(workOrderId, message, companyId) {
  console.log(`📩 [STUB] Notificación a cliente — OT #${workOrderId} (Empresa ${companyId}): ${message}`);
}

// ─── Vehículos ────────────────────────────────────────────────────────────────

/**
 * Busca un vehículo por placa dentro de la empresa.
 * - Si existe: actualiza con COALESCE los campos enviados y actualiza consentimiento si viene en el body.
 * - Si no existe: lo crea con su company_id y retorna el vehículo nuevo.
 *
 * Si whatsapp_opt_in es true, valida que el teléfono sea un celular peruano válido (422 si no).
 *
 * @param {{ placa, brand, model, customer_name, customer_phone, whatsapp_opt_in }} param0
 * @param {number} companyId
 * @param {object} [clientOrPool=pool]
 * @returns {object} vehicle row
 */
export async function findOrCreateVehicle(
  { placa, brand, model, customer_name, customer_phone, whatsapp_opt_in },
  companyId,
  clientOrPool = pool
) {
  let normalizedPhone = null;
  if (whatsapp_opt_in === true) {
    normalizedPhone = normalizePhonePE(customer_phone);
    if (!normalizedPhone) {
      throw new AppError(
        'Ingresa un celular válido de 9 dígitos para enviar avisos por WhatsApp',
        'INVALID_PHONE',
        422
      );
    }
  } else if (customer_phone) {
    normalizedPhone = normalizePhonePE(customer_phone) || customer_phone;
  }

  // Buscar por placa y empresa
  const found = await clientOrPool.query(
    `SELECT * FROM vehicles WHERE placa = $1 AND company_id = $2`,
    [placa, companyId]
  );

  if (found.rows.length > 0) {
    const hasOptInParam = whatsapp_opt_in !== undefined;
    const optInVal = Boolean(whatsapp_opt_in);

    const { rows } = await clientOrPool.query(
      `UPDATE vehicles
       SET
         brand              = COALESCE($1, brand),
         model              = COALESCE($2, model),
         customer_name      = COALESCE($3, customer_name),
         customer_phone     = COALESCE($4, customer_phone),
         whatsapp_opt_in    = CASE WHEN $5 THEN $6 ELSE whatsapp_opt_in END,
         whatsapp_opt_in_at = CASE WHEN $5 AND $6 THEN NOW() WHEN $5 AND NOT $6 THEN NULL ELSE whatsapp_opt_in_at END
       WHERE id = $7 AND company_id = $8
       RETURNING *`,
      [
        brand ?? null,
        model ?? null,
        customer_name ?? null,
        normalizedPhone ?? (customer_phone ?? null),
        hasOptInParam,
        optInVal,
        found.rows[0].id,
        companyId,
      ]
    );
    return rows[0];
  }

  // No existe: crear vinculado a la empresa
  const optInVal = Boolean(whatsapp_opt_in);
  const { rows } = await clientOrPool.query(
    `INSERT INTO vehicles (company_id, placa, brand, model, customer_name, customer_phone, whatsapp_opt_in, whatsapp_opt_in_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN NOW() ELSE NULL END)
     RETURNING *`,
    [
      companyId,
      placa,
      brand ?? null,
      model ?? null,
      customer_name,
      normalizedPhone ?? (customer_phone ?? null),
      optInVal,
    ]
  );
  return rows[0];
}

const DECISION_CHANNELS = ['presencial', 'whatsapp', 'telefono'];
const EDITABLE_ITEM_WO_STATUSES = ['recibido', 'diagnostico', 'pendiente_aprobacion', 'en_reparacion'];
const ORIGIN_BY_WO_STATUS = {
  recibido: 'recepcion',
  diagnostico: 'diagnostico',
  pendiente_aprobacion: 'reparacion',
  en_reparacion: 'reparacion',
};

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Calcula los totales resumidos de una colección de líneas de work_order_items (sin IGV).
 */
export function buildWorkOrderItemsSummary(items = []) {
  let approvedTotal = 0;
  let pendingTotal = 0;
  let rejectedTotal = 0;

  for (const item of items) {
    const lineSub = round2(Number(item.unit_price) * Number(item.quantity));
    if (item.status === 'aprobada') approvedTotal = round2(approvedTotal + lineSub);
    else if (item.status === 'propuesta') pendingTotal = round2(pendingTotal + lineSub);
    else if (item.status === 'rechazada') rejectedTotal = round2(rejectedTotal + lineSub);
  }

  return {
    items_count: items.length,
    approved_total: approvedTotal,
    pending_total: pendingTotal,
    rejected_total: rejectedTotal,
    active_total: round2(approvedTotal + pendingTotal),
    has_pending_items: items.some((i) => i.status === 'propuesta'),
  };
}

/**
 * Obtiene en lote las líneas de work_order_items asociadas a un conjunto de OT.
 */
async function fetchItemsByWorkOrderIds(workOrderIds, companyId, db = pool) {
  if (!workOrderIds || workOrderIds.length === 0) return new Map();

  const { rows } = await db.query(
    `SELECT woi.*,
            COALESCE(p.name, k.name, woi.description) AS display_name,
            p.sku AS product_sku,
            p.stock AS current_stock,
            p.is_active AS product_is_active,
            k.is_active AS kit_is_active,
            cu.name AS created_by_name,
            du.name AS decided_by_name
     FROM   work_order_items woi
     LEFT JOIN products p  ON p.id  = woi.product_id AND p.company_id = woi.company_id
     LEFT JOIN kits     k  ON k.id  = woi.kit_id     AND k.company_id = woi.company_id
     LEFT JOIN users    cu ON cu.id = woi.created_by
     LEFT JOIN users    du ON du.id = woi.decided_by
     WHERE  woi.work_order_id = ANY($1::int[]) AND woi.company_id = $2
     ORDER  BY woi.id ASC`,
    [workOrderIds.map(Number), companyId]
  );

  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.work_order_id) || [];
    list.push({
      ...row,
      subtotal: round2(Number(row.unit_price) * Number(row.quantity)),
    });
    grouped.set(row.work_order_id, list);
  }
  return grouped;
}

/**
 * Enriquece filas de OT con items, items_count, approved_total y pending_total sin alterar campos existentes.
 */
async function attachItemsToOrders(orders, companyId, db = pool) {
  if (!orders || orders.length === 0) return orders;
  const ids = orders.map((o) => o.id);
  const itemsByWo = await fetchItemsByWorkOrderIds(ids, companyId, db);

  return orders.map((o) => {
    const items = itemsByWo.get(o.id) || [];
    const summary = buildWorkOrderItemsSummary(items);
    return {
      ...o,
      items,
      items_count: summary.items_count,
      approved_total: summary.approved_total,
      pending_total: summary.pending_total,
    };
  });
}

/**
 * Recalcula work_orders.additional_cost como la suma de líneas no rechazadas (sin IGV).
 */
async function recalculateAdditionalCostInTx(client, workOrderId, companyId) {
  const { rows: sumRows } = await client.query(
    `SELECT COALESCE(SUM(ROUND(unit_price * quantity, 2)), 0) AS derived_total
     FROM   work_order_items
     WHERE  work_order_id = $1 AND company_id = $2 AND status <> 'rechazada'`,
    [workOrderId, companyId]
  );
  const derivedTotal = round2(sumRows[0]?.derived_total || 0);

  const { rows: woRows } = await client.query(
    `UPDATE work_orders
     SET additional_cost = $1,
         updated_at      = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING *`,
    [derivedTotal, workOrderId, companyId]
  );

  return { derivedTotal, updatedWorkOrder: woRows[0] };
}

// ─── Órdenes de Trabajo ───────────────────────────────────────────────────────

/**
 * Crea una nueva OT en estado 'recibido'.
 * Llama a findOrCreateVehicle internamente pasando companyId.
 *
 * Campos obligatorios: placa, customer_name, entry_mileage.
 *
 * @param {object} data
 * @param {number} companyId
 * @throws {AppError} si falta algún campo obligatorio
 */
export async function createWorkOrder(data, companyId) {
  const {
    placa,
    brand,
    model,
    customer_name,
    customer_phone,
    entry_mileage,
    checklist_notes,
    whatsapp_opt_in,
    mechanic_id,
  } = data;

  // Validación de campos obligatorios
  if (!placa || String(placa).trim() === '') {
    throw new AppError('El campo "placa" es obligatorio.', 'MISSING_FIELD', 422);
  }
  if (!customer_name || String(customer_name).trim() === '') {
    throw new AppError('El campo "customer_name" es obligatorio.', 'MISSING_FIELD', 422);
  }
  if (entry_mileage === undefined || entry_mileage === null || entry_mileage === '') {
    throw new AppError('El campo "entry_mileage" es obligatorio.', 'MISSING_FIELD', 422);
  }
  if (Number(entry_mileage) < 0 || isNaN(Number(entry_mileage))) {
    throw new AppError('"entry_mileage" debe ser un número entero >= 0.', 'INVALID_FIELD', 422);
  }

  // A-02: validar mechanic_id opcional (igual que assignMechanic)
  let resolvedMechanicId = null;
  if (mechanic_id !== undefined && mechanic_id !== null && mechanic_id !== '') {
    const { rows: userRows } = await pool.query(
      `SELECT id, name, role, is_active FROM users WHERE id = $1 AND company_id = $2`,
      [mechanic_id, companyId]
    );
    if (!userRows[0] || !userRows[0].is_active) {
      throw new AppError(
        `No existe un mecánico activo con id ${mechanic_id}.`,
        'MECHANIC_NOT_FOUND',
        404
      );
    }
    if (userRows[0].role !== 'mecanico') {
      throw new AppError(
        `El usuario #${mechanic_id} tiene rol '${userRows[0].role}', se requiere 'mecanico'.`,
        'INVALID_MECHANIC',
        422
      );
    }
    resolvedMechanicId = Number(mechanic_id);
  }

  const vehicle = await findOrCreateVehicle(
    {
      placa: placa.trim().toUpperCase(),
      brand,
      model,
      customer_name: customer_name.trim(),
      customer_phone,
      whatsapp_opt_in,
    },
    companyId
  );

  const { rows } = await pool.query(
    `INSERT INTO work_orders (company_id, vehicle_id, entry_mileage, checklist_notes, mechanic_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [companyId, vehicle.id, Number(entry_mileage), checklist_notes ?? null, resolvedMechanicId]
  );

  const workOrder = rows[0];

  // Si el cliente dio su consentimiento para WhatsApp, emitir aviso de 'recibido' (RF-15)
  if (vehicle.whatsapp_opt_in) {
    await createWhatsAppNoticeIfEligible({
      workOrderId: workOrder.id,
      companyId,
      event: WHATSAPP_EVENTS.RECIBIDO,
      vehicle,
    });
  }

  return {
    ...workOrder,
    vehicle,
    items: [],
    items_count: 0,
    approved_total: 0,
    pending_total: 0,
  };
}

/**
 * Lista todas las OT de la empresa con datos del vehículo asociado.
 * Filtra por status y/o mecánico asignado si se envían.
 *
 * @param {{ status?: string, mechanicId?: number }} options
 * @param {number}             companyId
 */
export async function getAll({ status, mechanicId } = {}, companyId) {
  const conditions = ['wo.company_id = $1'];
  const params = [companyId];

  if (status && status.trim() !== '') {
    params.push(status.trim());
    conditions.push(`wo.status = $${params.length}`);
  }

  if (mechanicId !== undefined && mechanicId !== null) {
    params.push(Number(mechanicId));
    conditions.push(`wo.mechanic_id = $${params.length}`);
  }

  const query = `
    SELECT wo.*, v.placa, v.brand, v.model, v.customer_name, v.customer_phone,
           u.name AS mechanic_name,
           s.id AS sale_id, (s.id IS NOT NULL) AS is_billed
    FROM   work_orders wo
    JOIN   vehicles    v  ON v.id  = wo.vehicle_id
    LEFT JOIN users    u  ON u.id  = wo.mechanic_id
    LEFT JOIN sales    s  ON s.work_order_id = wo.id AND s.company_id = wo.company_id AND s.status = 'completed'
    WHERE  ${conditions.join(' AND ')}
    ORDER  BY wo.id ASC
  `;

  const { rows } = await pool.query(query, params);
  return attachItemsToOrders(rows, companyId);
}

/**
 * Retorna una OT por id con datos del vehículo, validando pertenencia a la empresa.
 * @param {number|string} id
 * @param {number}        companyId
 * @returns {object|null}
 */
export async function getById(id, companyId) {
  const { rows } = await pool.query(
    `SELECT wo.*, v.placa, v.brand, v.model, v.customer_name, v.customer_phone,
            u.name AS mechanic_name,
            s.id AS sale_id, (s.id IS NOT NULL) AS is_billed
     FROM   work_orders wo
     JOIN   vehicles    v  ON v.id = wo.vehicle_id
     LEFT JOIN users    u  ON u.id = wo.mechanic_id
     LEFT JOIN sales    s  ON s.work_order_id = wo.id AND s.company_id = wo.company_id AND s.status = 'completed'
     WHERE  wo.id = $1 AND wo.company_id = $2`,
    [id, companyId]
  );
  const order = rows[0] ?? null;
  if (!order) return null;
  const [enriched] = await attachItemsToOrders([order], companyId);
  return enriched;
}

/**
 * RF-14: historial de OT de un vehículo por placa, dentro de la misma empresa.
 * @param {string} placa
 * @param {number} companyId
 * @returns {object[]}
 */
export async function getHistoryByPlaca(placa, companyId) {
  const { rows } = await pool.query(
    `SELECT wo.*, v.placa, v.brand, v.model, v.customer_name, v.customer_phone,
            u.name AS mechanic_name,
            s.id AS sale_id, (s.id IS NOT NULL) AS is_billed
     FROM   work_orders wo
     JOIN   vehicles    v  ON v.id = wo.vehicle_id
     LEFT JOIN users    u  ON u.id = wo.mechanic_id
     LEFT JOIN sales    s  ON s.work_order_id = wo.id AND s.company_id = wo.company_id AND s.status = 'completed'
     WHERE  v.placa = $1 AND v.company_id = $2 AND wo.company_id = $2
     ORDER  BY wo.created_at DESC`,
    [placa.trim().toUpperCase(), companyId]
  );
  return attachItemsToOrders(rows, companyId);
}

/**
 * Asigna un mecánico real a una OT.
 * Valida que la OT y el mecánico pertenezcan a la misma empresa.
 *
 * @param {number|string} id           ID de la OT
 * @param {number|string} mechanic_id  ID del usuario con role='mecanico'
 * @param {number}        companyId
 */
export async function assignMechanic(id, mechanic_id, companyId) {
  // Validar que la OT existe y pertenece a la empresa
  const order = await getById(id, companyId);
  if (!order) {
    throw new AppError(`Orden de trabajo #${id} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
  }

  // Validar que el mecánico existe en la misma empresa, tiene role='mecanico' y está activo
  const { rows: userRows } = await pool.query(
    `SELECT id, name, role, is_active FROM users WHERE id = $1 AND company_id = $2`,
    [mechanic_id, companyId]
  );

  if (!userRows[0] || !userRows[0].is_active) {
    throw new AppError(
      `No existe un mecánico activo con id ${mechanic_id}.`,
      'MECHANIC_NOT_FOUND',
      404
    );
  }
  if (userRows[0].role !== 'mecanico') {
    throw new AppError(
      `El usuario #${mechanic_id} tiene rol '${userRows[0].role}', se requiere 'mecanico'.`,
      'INVALID_MECHANIC',
      422
    );
  }

  const { rows } = await pool.query(
    `UPDATE work_orders
     SET mechanic_id = $1, updated_at = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING *`,
    [mechanic_id, id, companyId]
  );
  return rows[0] ?? null;
}

/**
 * Actualiza el estado de una OT aplicando la máquina de estados.
 *
 * @param {number|string} id
 * @param {string}        newStatus
 * @param {{ diagnosis_notes?: string, additional_cost?: number }} extras
 * @param {number}        companyId
 * @param {{ userRole?: string, userId?: number }} [actor]
 */
/**
 * Valida reglas de transición por rol y VALID_TRANSITIONS para una OT dada.
 * Reutilizable tanto en PATCH /workorders/:id/status como en cobro POS (POST /sales).
 *
 * @param {object} current
 * @param {string} newStatus
 * @param {{ userRole?: string, userId?: number }} [actor]
 */
export function assertCanTransitionWorkOrder(current, newStatus, { userRole, userId } = {}) {
  // Restricciones para el rol mecanico (Tarea 14.1 / 14.1b)
  if (userRole === 'mecanico') {
    if (!current.mechanic_id || Number(current.mechanic_id) !== Number(userId)) {
      throw new AppError('Esta orden no está asignada a ti.', 'WORK_ORDER_NOT_ASSIGNED', 403);
    }
    if (current.status === 'pendiente_aprobacion') {
      throw new AppError(
        'Esta orden espera la aprobación del cliente. Solo el cajero o el admin pueden aprobarla.',
        'APPROVAL_REQUIRED',
        403
      );
    }
    const ALLOWED_MECHANIC_TARGETS = ['diagnostico', 'en_reparacion', 'terminado'];
    if (!ALLOWED_MECHANIC_TARGETS.includes(newStatus)) {
      throw new AppError(
        `Los mecánicos no pueden cambiar el estado a '${newStatus}'.`,
        'STATUS_NOT_ALLOWED_FOR_ROLE',
        403
      );
    }
  }

  // A-03: Restricciones para el rol cajero
  if (userRole === 'cajero') {
    const ALLOWED_CAJERO_SOURCES = ['terminado', 'no_recogido', 'pendiente_aprobacion'];
    if (!ALLOWED_CAJERO_SOURCES.includes(current.status)) {
      throw new AppError(
        `El cajero solo puede cambiar el estado desde "terminado", "no_recogido" o "pendiente_aprobacion".`,
        'STATUS_NOT_ALLOWED_FOR_ROLE',
        403
      );
    }
    if (newStatus !== 'entregado') {
      throw new AppError(
        `El cajero solo puede cambiar el estado a "entregado".`,
        'STATUS_NOT_ALLOWED_FOR_ROLE',
        403
      );
    }
  }

  const currentStatus = current.status;
  const allowed = VALID_TRANSITIONS[currentStatus] ?? [];

  // b) Verificar que la transición solicitada es válida
  if (!allowed.includes(newStatus)) {
    throw new AppError(
      `Transición inválida: '${currentStatus}' → '${newStatus}'. ` +
        `Desde '${currentStatus}' solo se puede pasar a: [${allowed.join(', ') || 'ninguno'}].`,
      'INVALID_TRANSITION',
      422
    );
  }
}

/**
 * Marca una OT (ya bloqueada con FOR UPDATE) como 'entregado' dentro de una transacción abierta.
 * Replica la validación de roles y transiciones de updateStatus más el UPDATE de entrega.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} currentOrder
 * @param {number} companyId
 * @param {{ userRole?: string, userId?: number }|null} [actor]
 * @returns {Promise<object>}
 */
export async function deliverWorkOrderInTx(client, currentOrder, companyId, actor = null) {
  assertCanTransitionWorkOrder(currentOrder, 'entregado', actor ?? {});

  const { rows } = await client.query(
    `UPDATE work_orders
     SET status     = 'entregado',
         updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [currentOrder.id, companyId]
  );

  return rows[0];
}

export async function updateStatus(
  id,
  newStatus,
  { diagnosis_notes, additional_cost } = {},
  companyId,
  { userRole, userId } = {}
) {
  const client = await pool.connect();
  let updated;
  let resolvedStatus = newStatus;
  let requiresApproval = false;
  let effectiveAdditionalCost = null;

  try {
    await client.query('BEGIN');

    // a) Verificar que la OT existe en la empresa y bloquearla
    const { rows: woRows } = await client.query(
      `SELECT * FROM work_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    const current = woRows[0];
    if (!current) {
      throw new AppError(`Orden de trabajo #${id} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
    }

    assertCanTransitionWorkOrder(current, newStatus, { userRole, userId });

    const currentStatus = current.status;

    // Consultar líneas detalladas en work_order_items (si existen, gobiernan montos y candados)
    const { rows: woItems } = await client.query(
      `SELECT id, status, unit_price, quantity
       FROM   work_order_items
       WHERE  work_order_id = $1 AND company_id = $2
       FOR UPDATE`,
      [id, companyId]
    );

    const hasItems = woItems.length > 0;
    const summary = buildWorkOrderItemsSummary(woItems);
    const derivedTotal = summary.active_total;
    const pendingItems = woItems.filter((it) => it.status === 'propuesta');

    // b) Opción A: si la OT tiene líneas, rechazar additional_cost distinto del derivado (tolerancia 0.01)
    if (
      hasItems &&
      additional_cost !== undefined &&
      additional_cost !== null &&
      String(additional_cost).trim() !== ''
    ) {
      const sentCost = Number(additional_cost);
      if (!Number.isFinite(sentCost) || Math.abs(sentCost - derivedTotal) > 0.01) {
        throw new AppError(
          `Esta orden tiene repuestos o servicios por línea (total S/ ${derivedTotal.toFixed(2)}). Agrega o decide las líneas desde la orden en lugar de editar el monto adicional.`,
          'ADDITIONAL_COST_DERIVED_FROM_ITEMS',
          422
        );
      }
    }

    // c) Bloqueo en_reparacion → terminado mientras haya líneas pendientes de aprobación
    if (hasItems && currentStatus === 'en_reparacion' && newStatus === 'terminado' && pendingItems.length > 0) {
      throw new AppError(
        `No puedes marcar la orden como terminada porque hay ${pendingItems.length} ítem(s) pendiente(s) de aprobación del cliente.`,
        'PENDING_ITEMS',
        422
      );
    }

    // d) Regla RF-16: desviar a pendiente_aprobacion si supera el umbral configurado
    const { rows: compRows } = await client.query(
      'SELECT approval_threshold FROM companies WHERE id = $1',
      [companyId]
    );
    const approvalThreshold =
      compRows[0] && compRows[0].approval_threshold != null
        ? Number(compRows[0].approval_threshold)
        : 100;

    effectiveAdditionalCost = hasItems
      ? derivedTotal
      : additional_cost != null && String(additional_cost).trim() !== ''
        ? Number(additional_cost)
        : null;

    if (
      currentStatus === 'diagnostico' &&
      newStatus === 'en_reparacion' &&
      effectiveAdditionalCost != null &&
      effectiveAdditionalCost > approvalThreshold
    ) {
      resolvedStatus = 'pendiente_aprobacion';
      requiresApproval = true;
    } else if (
      hasItems &&
      currentStatus === 'diagnostico' &&
      newStatus === 'en_reparacion' &&
      pendingItems.length > 0
    ) {
      // No superó el umbral: aprobar automáticamente las líneas propuestas con canal 'umbral'
      const { rows: approvedRows } = await client.query(
        `UPDATE work_order_items
         SET status           = 'aprobada',
             decided_by       = $1,
             decided_at       = NOW(),
             decision_channel = 'umbral',
             updated_at       = NOW()
         WHERE work_order_id = $2 AND company_id = $3 AND status = 'propuesta'
         RETURNING *`,
        [userId ?? null, id, companyId]
      );
      for (const item of approvedRows) {
        await logAudit(client, {
          companyId,
          userId: userId ?? null,
          entity: 'work_order_item',
          entityId: item.id,
          action: 'update',
          changes: {
            work_order_id: Number(id),
            status: { old: 'propuesta', new: 'aprobada' },
            decision_channel: 'umbral',
          },
        });
      }
    }

    // e) Si el estado destino es 'terminado', rellenar terminado_at
    const isTerminado = resolvedStatus === 'terminado';

    const { rows } = await client.query(
      `UPDATE work_orders
       SET
         status          = $1,
         diagnosis_notes = COALESCE($2, diagnosis_notes),
         additional_cost = CASE WHEN $7 THEN $3 ELSE COALESCE($3, additional_cost) END,
         terminado_at    = CASE WHEN $4 THEN NOW() ELSE terminado_at END,
         updated_at      = NOW()
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [
        resolvedStatus,
        diagnosis_notes ?? null,
        effectiveAdditionalCost,
        isTerminado,
        id,
        companyId,
        hasItems,
      ]
    );

    updated = rows[0];

    // f) Notificar al cliente si aplica plantilla de WhatsApp (RF-15)
    if (resolvedStatus === 'pendiente_aprobacion') {
      await createWhatsAppNoticeIfEligible({
        workOrderId: id,
        companyId,
        event: WHATSAPP_EVENTS.PENDIENTE_APROBACION,
        params: { monto: effectiveAdditionalCost ?? updated.additional_cost },
        clientOrPool: client,
      });
    } else if (resolvedStatus === 'terminado') {
      await createWhatsAppNoticeIfEligible({
        workOrderId: id,
        companyId,
        event: WHATSAPP_EVENTS.TERMINADO,
        clientOrPool: client,
      });
    } else if (resolvedStatus === 'no_recogido') {
      const dias = Math.max(
        1,
        Math.floor(
          (Date.now() - new Date(updated.terminado_at || updated.updated_at).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      );
      await createWhatsAppNoticeIfEligible({
        workOrderId: id,
        companyId,
        event: WHATSAPP_EVENTS.NO_RECOGIDO,
        params: { dias },
        clientOrPool: client,
      });
    }

    await client.query('COMMIT');
    return { ...updated, requiresApproval };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * UC-03 FA-1: el cliente aprueba el trabajo adicional.
 * Solo válido si status === 'pendiente_aprobacion'.
 * Mueve a 'en_reparacion' y aprueba en lote las líneas en estado 'propuesta'.
 *
 * @param {number|string} id
 * @param {number}        companyId
 * @param {{ channel?: string, userId?: number }} [options]
 */
export async function approveAdditionalWork(id, companyId, { channel, userId } = {}) {
  const resolvedChannel = channel ?? 'presencial';
  if (!DECISION_CHANNELS.includes(resolvedChannel)) {
    throw new AppError(
      `Canal de decisión inválido. Debe ser: ${DECISION_CHANNELS.join(', ')}.`,
      'INVALID_FIELD',
      422
    );
  }

  const client = await pool.connect();
  let updated;
  try {
    await client.query('BEGIN');

    const { rows: currentRows } = await client.query(
      `SELECT * FROM work_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    const current = currentRows[0];
    if (!current) {
      throw new AppError(`Orden de trabajo #${id} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
    }
    if (current.status !== 'pendiente_aprobacion') {
      throw new AppError(
        `Solo se puede aprobar una OT en estado 'pendiente_aprobacion'. Estado actual: '${current.status}'.`,
        'INVALID_TRANSITION',
        422
      );
    }

    const { rows } = await client.query(
      `UPDATE work_orders
       SET status = 'en_reparacion', updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, companyId]
    );
    updated = rows[0];

    const { rows: approvedRows } = await client.query(
      `UPDATE work_order_items
       SET status           = 'aprobada',
           decided_by       = $1,
           decided_at       = NOW(),
           decision_channel = $2,
           updated_at       = NOW()
       WHERE work_order_id = $3 AND company_id = $4 AND status = 'propuesta'
       RETURNING *`,
      [userId ?? null, resolvedChannel, id, companyId]
    );
    for (const item of approvedRows) {
      await logAudit(client, {
        companyId,
        userId: userId ?? null,
        entity: 'work_order_item',
        entityId: item.id,
        action: 'update',
        changes: {
          work_order_id: Number(id),
          status: { old: 'propuesta', new: 'aprobada' },
          decision_channel: resolvedChannel,
        },
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await notifyClient(id, 'El cliente aprobó el trabajo adicional. La reparación ha comenzado.', companyId);
  return updated;
}

/**
 * UC-03 FA-2: el cliente rechaza el trabajo adicional.
 * Solo válido si status === 'pendiente_aprobacion'.
 * Mueve a 'entregado' (cierre parcial) y rechaza las líneas en estado 'propuesta'.
 *
 * @param {number|string} id
 * @param {number}        companyId
 * @param {{ channel?: string, userId?: number }} [options]
 */
export async function rejectAdditionalWork(id, companyId, { channel, userId } = {}) {
  const resolvedChannel = channel ?? 'presencial';
  if (!DECISION_CHANNELS.includes(resolvedChannel)) {
    throw new AppError(
      `Canal de decisión inválido. Debe ser: ${DECISION_CHANNELS.join(', ')}.`,
      'INVALID_FIELD',
      422
    );
  }

  const client = await pool.connect();
  let updated;
  try {
    await client.query('BEGIN');

    const { rows: currentRows } = await client.query(
      `SELECT * FROM work_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    const current = currentRows[0];
    if (!current) {
      throw new AppError(`Orden de trabajo #${id} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
    }
    if (current.status !== 'pendiente_aprobacion') {
      throw new AppError(
        `Solo se puede rechazar una OT en estado 'pendiente_aprobacion'. Estado actual: '${current.status}'.`,
        'INVALID_TRANSITION',
        422
      );
    }

    const { rows: rejectedRows } = await client.query(
      `UPDATE work_order_items
       SET status           = 'rechazada',
           decided_by       = $1,
           decided_at       = NOW(),
           decision_channel = $2,
           updated_at       = NOW()
       WHERE work_order_id = $3 AND company_id = $4 AND status = 'propuesta'
       RETURNING *`,
      [userId ?? null, resolvedChannel, id, companyId]
    );

    const { rows: hasItemsRows } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM work_order_items WHERE work_order_id = $1 AND company_id = $2`,
      [id, companyId]
    );

    if (rejectedRows.length > 0 || Number(hasItemsRows[0]?.cnt) > 0) {
      await recalculateAdditionalCostInTx(client, id, companyId);
    }

    const { rows } = await client.query(
      `UPDATE work_orders
       SET status = 'entregado', updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, companyId]
    );
    updated = rows[0];

    for (const item of rejectedRows) {
      await logAudit(client, {
        companyId,
        userId: userId ?? null,
        entity: 'work_order_item',
        entityId: item.id,
        action: 'update',
        changes: {
          work_order_id: Number(id),
          status: { old: 'propuesta', new: 'rechazada' },
          decision_channel: resolvedChannel,
        },
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await notifyClient(
    id,
    'El cliente rechazó el trabajo adicional. El vehículo será devuelto con el diagnóstico realizado.',
    companyId
  );
  return updated;
}

/**
 * Marca una OT como 'no_recogido'.
 * Solo válido si status === 'terminado'.
 *
 * @param {number|string} id
 * @param {number}        companyId
 */
export async function markNotPickedUp(id, companyId) {
  const current = await getById(id, companyId);
  if (!current) {
    throw new AppError(`Orden de trabajo #${id} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
  }
  if (current.status !== 'terminado') {
    throw new AppError(
      `Solo se puede marcar como no_recogido una OT en estado 'terminado'. Estado actual: '${current.status}'.`,
      'INVALID_TRANSITION',
      422
    );
  }

  const { rows } = await pool.query(
    `UPDATE work_orders
     SET status = 'no_recogido', updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [id, companyId]
  );

  const dias = Math.max(
    1,
    Math.floor(
      (Date.now() - new Date(current.terminado_at || current.updated_at).getTime()) /
        (1000 * 60 * 60 * 24)
    )
  );
  await createWhatsAppNoticeIfEligible({
    workOrderId: id,
    companyId,
    event: WHATSAPP_EVENTS.NO_RECOGIDO,
    params: { dias },
  });

  return rows[0];
}

/**
 * Marca automáticamente como 'no_recogido' las órdenes de trabajo terminadas
 * que superan el plazo not_picked_up_days configurado por su empresa (RF-17).
 *
 * Idempotente y seguro para ejecutarse concurrentemente en múltiples instancias.
 * Registra en una sola transacción los cambios en audit_logs y las filas en notifications.
 * Si el cliente dio consentimiento para WhatsApp, genera también el aviso pendiente (RF-15).
 *
 * @returns {Promise<{ updated: number, by_company: Record<string, number> }>}
 */
export async function markOverdueNotPickedUp() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updateQuery = `
      UPDATE work_orders wo
      SET    status = 'no_recogido',
             updated_at = NOW()
      FROM   companies c, vehicles v
      WHERE  wo.company_id = c.id
        AND  wo.vehicle_id = v.id
        AND  c.is_active = true
        AND  c.status IN ('active', 'trial')
        AND  wo.status = 'terminado'
        AND  wo.terminado_at IS NOT NULL
        AND  wo.terminado_at < NOW() - make_interval(days => c.not_picked_up_days)
      RETURNING
        wo.id,
        wo.company_id,
        v.placa,
        v.customer_name,
        v.customer_phone,
        v.whatsapp_opt_in,
        c.nombre_comercial,
        c.razon_social,
        c.not_picked_up_days,
        FLOOR(EXTRACT(EPOCH FROM (NOW() - wo.terminado_at)) / 86400)::int AS dias_esperando
    `;

    const { rows } = await client.query(updateQuery);

    const byCompany = {};

    for (const row of rows) {
      const cid = String(row.company_id);
      byCompany[cid] = (byCompany[cid] || 0) + 1;

      // 1. Registro en audit_logs (inmutable, user_id NULL para operaciones automáticas del sistema)
      await client.query(
        `INSERT INTO audit_logs (company_id, user_id, entity, entity_id, action, changes)
         VALUES ($1, NULL, 'work_order', $2, 'auto_not_picked_up', $3)`,
        [
          row.company_id,
          row.id,
          JSON.stringify({
            status: { old: 'terminado', new: 'no_recogido' },
            dias_esperando: row.dias_esperando,
          }),
        ]
      );

      // 2. Registro en notifications (sistema/stub, status 'skipped')
      const msg = `Moto ${row.placa} lleva ${row.dias_esperando} días terminada sin ser recogida`;
      await client.query(
        `INSERT INTO notifications (company_id, work_order_id, message, channel, status)
         VALUES ($1, $2, $3, 'stub', 'skipped')`,
        [row.company_id, row.id, msg]
      );

      // 3. Si el cliente dio consentimiento para WhatsApp (RF-15), generar el aviso pendiente
      const normalizedPhone = normalizePhonePE(row.customer_phone);
      if (row.whatsapp_opt_in && normalizedPhone) {
        const taller = (row.nombre_comercial || row.razon_social || '').trim();
        const waMsg = buildWhatsAppMessage(WHATSAPP_EVENTS.NO_RECOGIDO, {
          cliente: row.customer_name,
          placa: row.placa,
          taller,
          dias: row.dias_esperando,
        });
        if (waMsg) {
          await client.query(
            `INSERT INTO notifications (company_id, work_order_id, message, channel, status, event)
             VALUES ($1, $2, $3, 'whatsapp', 'pending', $4)`,
            [row.company_id, row.id, waMsg, WHATSAPP_EVENTS.NO_RECOGIDO]
          );
        }
      }
    }

    await client.query('COMMIT');

    return {
      updated: rows.length,
      by_company: byCompany,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Consulta alertas de retiro de motos para admin y cajero (RF-17).
 * - not_picked_up: OTs con status = 'no_recogido'.
 * - due_soon: OTs terminadas a las que les faltan 2 días o menos para vencer el plazo not_picked_up_days.
 *
 * @param {number} companyId
 * @returns {Promise<{ not_picked_up: Array<object>, due_soon: Array<object> }>}
 */
export async function getPickupAlerts(companyId) {
  // 1. Motos en estado 'no_recogido'
  const notPickedUpQuery = `
    SELECT
      wo.id,
      v.placa,
      v.customer_name  AS cliente,
      v.customer_phone AS telefono,
      wo.terminado_at,
      FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(wo.terminado_at, wo.updated_at))) / 86400)::int AS dias_esperando
    FROM  work_orders wo
    JOIN  vehicles v ON v.id = wo.vehicle_id
    WHERE wo.company_id = $1
      AND wo.status = 'no_recogido'
    ORDER BY dias_esperando DESC, wo.id DESC
  `;

  // 2. Motos terminadas a las que les faltan 2 días o menos para vencer
  const dueSoonQuery = `
    SELECT
      wo.id,
      v.placa,
      v.customer_name  AS cliente,
      v.customer_phone AS telefono,
      wo.terminado_at,
      FLOOR(EXTRACT(EPOCH FROM (NOW() - wo.terminado_at)) / 86400)::int AS dias_esperando
    FROM  work_orders wo
    JOIN  vehicles v ON v.id = wo.vehicle_id
    JOIN  companies c ON c.id = wo.company_id
    WHERE wo.company_id = $1
      AND wo.status = 'terminado'
      AND wo.terminado_at IS NOT NULL
      AND wo.terminado_at <= NOW() - make_interval(days => GREATEST(0, c.not_picked_up_days - 2))
      AND wo.terminado_at >= NOW() - make_interval(days => c.not_picked_up_days)
    ORDER BY dias_esperando DESC, wo.id DESC
  `;

  const [resNotPicked, resDueSoon] = await Promise.all([
    pool.query(notPickedUpQuery, [companyId]),
    pool.query(dueSoonQuery, [companyId]),
  ]);

  return {
    not_picked_up: resNotPicked.rows,
    due_soon:      resDueSoon.rows,
  };
}

/**
 * Consulta el historial de notificaciones/avisos de una orden de trabajo (RF-15).
 *
 * @param {number|string} orderId
 * @param {number} companyId
 * @returns {Promise<Array<object>>}
 */
export async function getOrderNotifications(orderId, companyId) {
  const current = await getById(orderId, companyId);
  if (!current) {
    throw new AppError(`Orden de trabajo #${orderId} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
  }

  const { rows } = await pool.query(
    `SELECT n.id, n.work_order_id, n.message, n.channel, n.status, n.event,
            n.created_at, n.opened_at, n.opened_by, u.name AS opened_by_name
     FROM notifications n
     LEFT JOIN users u ON u.id = n.opened_by
     WHERE n.work_order_id = $1 AND n.company_id = $2
     ORDER BY n.created_at DESC`,
    [orderId, companyId]
  );
  return rows;
}

// ─── Ítems por línea en Órdenes de Trabajo (cuenta abierta) ──────────────────

/**
 * GET /api/workorders/:id/items
 * Admin, cajero y almacenero ven cualquier OT de la empresa; mecánico solo sus OT asignadas.
 */
export async function getOrderItems(workOrderId, companyId, { userRole, userId } = {}) {
  const { rows: woRows } = await pool.query(
    `SELECT id, mechanic_id, status FROM work_orders WHERE id = $1 AND company_id = $2`,
    [workOrderId, companyId]
  );
  const current = woRows[0];
  if (!current) {
    throw new AppError(`Orden de trabajo #${workOrderId} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
  }
  if (userRole === 'mecanico' && (!current.mechanic_id || Number(current.mechanic_id) !== Number(userId))) {
    throw new AppError('Esta orden no está asignada a ti.', 'WORK_ORDER_NOT_ASSIGNED', 403);
  }

  const itemsMap = await fetchItemsByWorkOrderIds([current.id], companyId);
  const items = itemsMap.get(current.id) || [];
  return {
    items,
    summary: buildWorkOrderItemsSummary(items),
  };
}

/**
 * POST /api/workorders/:id/items
 * Solo admin y cajero. Agrega línea product | kit | service a una OT abierta.
 * Toda línea nueva nace en 'propuesta', congela unit_price sin IGV del catálogo o servicio,
 * emite stock_warning sin bloquear si el stock no alcanza, y recalcula additional_cost.
 */
export async function addOrderItem(workOrderId, data = {}, companyId, { userId } = {}) {
  const { type, product_id, kit_id, description, unit_price, quantity = 1 } = data;

  if (!['product', 'kit', 'service'].includes(type)) {
    throw new AppError('El tipo de línea ("type") debe ser "product", "kit" o "service".', 'INVALID_ITEM', 422);
  }

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    throw new AppError('"quantity" debe ser un número entero mayor o igual a 1.', 'INVALID_FIELD', 422);
  }

  if (type === 'product' && (!Number.isInteger(Number(product_id)) || Number(product_id) <= 0 || kit_id != null)) {
    throw new AppError('Debes seleccionar un producto válido.', 'INVALID_ITEM', 422);
  }
  if (type === 'kit' && (!Number.isInteger(Number(kit_id)) || Number(kit_id) <= 0 || product_id != null)) {
    throw new AppError('Debes seleccionar un kit válido.', 'INVALID_ITEM', 422);
  }

  let serviceDesc = null;
  let servicePrice = null;
  if (type === 'service') {
    if (product_id != null || kit_id != null) {
      throw new AppError('Una línea de servicio no puede incluir producto ni kit.', 'INVALID_ITEM', 422);
    }
    serviceDesc = typeof description === 'string' ? description.trim() : '';
    if (serviceDesc.length < 1 || serviceDesc.length > 200) {
      throw new AppError('La descripción del servicio debe tener entre 1 y 200 caracteres.', 'INVALID_ITEM', 422);
    }
    const parsedPrice = Number(unit_price);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      throw new AppError('El precio unitario del servicio debe ser mayor a 0.', 'INVALID_ITEM', 422);
    }
    servicePrice = round2(parsedPrice);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: woRows } = await client.query(
      `SELECT id, status, company_id FROM work_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [workOrderId, companyId]
    );
    const wo = woRows[0];
    if (!wo) {
      throw new AppError(`Orden de trabajo #${workOrderId} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
    }
    if (!EDITABLE_ITEM_WO_STATUSES.includes(wo.status)) {
      throw new AppError(
        `No se pueden agregar líneas cuando la OT está en estado '${wo.status}'.`,
        'INVALID_TRANSITION',
        422
      );
    }

    const origin = ORIGIN_BY_WO_STATUS[wo.status] || 'diagnostico';
    let resolvedUnitPrice = servicePrice;
    let resolvedProductId = null;
    let resolvedKitId = null;
    let displayName = serviceDesc;
    let stockWarning = null;

    if (type === 'product') {
      const { rows: prodRows } = await client.query(
        `SELECT id, name, sale_price, stock FROM products WHERE id = $1 AND company_id = $2 AND is_active = true`,
        [Number(product_id), companyId]
      );
      if (!prodRows[0]) {
        throw new AppError(`Producto #${product_id} no encontrado o inactivo.`, 'PRODUCT_NOT_FOUND', 404);
      }
      const prod = prodRows[0];
      resolvedProductId = prod.id;
      resolvedUnitPrice = round2(prod.sale_price);
      if (resolvedUnitPrice <= 0) {
        throw new AppError(`El producto "${prod.name}" no tiene un precio de venta válido (> 0).`, 'INVALID_ITEM', 422);
      }
      displayName = prod.name;

      const { rows: activeQtyRows } = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS qty
         FROM work_order_items
         WHERE work_order_id = $1 AND company_id = $2 AND product_id = $3 AND status <> 'rechazada'`,
        [wo.id, companyId, prod.id]
      );
      const totalNeeded = Number(activeQtyRows[0]?.qty || 0) + qty;
      const available = Number(prod.stock);
      if (available < totalNeeded) {
        stockWarning = {
          product_id: prod.id,
          product_name: prod.name,
          available_stock: available,
          requested_quantity: qty,
          ot_total_quantity: totalNeeded,
          message: `Stock insuficiente para "${prod.name}": disponible ${available}, requerido en esta OT ${totalNeeded}.`,
        };
      }
    } else if (type === 'kit') {
      const { rows: kitRows } = await client.query(
        `SELECT id, name, kit_price FROM kits WHERE id = $1 AND company_id = $2 AND is_active = true`,
        [Number(kit_id), companyId]
      );
      if (!kitRows[0]) {
        throw new AppError(`Kit #${kit_id} no encontrado o inactivo.`, 'KIT_NOT_FOUND', 404);
      }
      const kit = kitRows[0];
      const { rows: components } = await client.query(
        `SELECT ki.product_id, ki.quantity, p.name, p.stock
         FROM kit_items ki
         JOIN products p ON p.id = ki.product_id AND p.company_id = $2
         WHERE ki.kit_id = $1`,
        [kit.id, companyId]
      );
      if (components.length === 0) {
        throw new AppError(`El kit "${kit.name}" no tiene componentes definidos.`, 'KIT_EMPTY', 422);
      }
      resolvedKitId = kit.id;
      resolvedUnitPrice = round2(kit.kit_price);
      if (resolvedUnitPrice <= 0) {
        throw new AppError(`El kit "${kit.name}" debe tener un precio mayor a 0.`, 'INVALID_ITEM', 422);
      }
      displayName = kit.name;

      const lowComps = components
        .filter((c) => Number(c.stock) < Number(c.quantity) * qty)
        .map((c) => ({
          product_id: c.product_id,
          product_name: c.name,
          available_stock: Number(c.stock),
          requested_quantity: Number(c.quantity) * qty,
        }));
      if (lowComps.length > 0) {
        stockWarning = {
          kit_id: kit.id,
          kit_name: kit.name,
          components: lowComps,
          message: `Stock insuficiente en componente(s) del kit "${kit.name}": ${lowComps
            .map((c) => `${c.product_name} (disp. ${c.available_stock}, req. ${c.requested_quantity})`)
            .join(', ')}.`,
        };
      }
    }

    const { rows: insRows } = await client.query(
      `INSERT INTO work_order_items
         (company_id, work_order_id, item_type, product_id, kit_id, description,
          quantity, unit_price, status, origin, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'propuesta', $9, $10)
       RETURNING *`,
      [
        companyId,
        wo.id,
        type,
        resolvedProductId,
        resolvedKitId,
        type === 'service' ? serviceDesc : null,
        qty,
        resolvedUnitPrice,
        origin,
        userId ?? null,
      ]
    );
    const createdItem = insRows[0];

    const { derivedTotal, updatedWorkOrder } = await recalculateAdditionalCostInTx(client, wo.id, companyId);

    await logAudit(client, {
      companyId,
      userId: userId ?? null,
      entity: 'work_order_item',
      entityId: createdItem.id,
      action: 'create',
      changes: {
        work_order_id: wo.id,
        item_type: type,
        display_name: displayName,
        quantity: qty,
        unit_price: resolvedUnitPrice,
        origin,
        status: 'propuesta',
        additional_cost: derivedTotal,
      },
    });

    const itemsMap = await fetchItemsByWorkOrderIds([wo.id], companyId, client);
    const allItems = itemsMap.get(wo.id) || [];
    const enrichedCreated = allItems.find((it) => it.id === createdItem.id) || createdItem;

    await client.query('COMMIT');

    return {
      item: enrichedCreated,
      summary: buildWorkOrderItemsSummary(allItems),
      work_order: updatedWorkOrder,
      stock_warning: stockWarning,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * PATCH /api/workorders/:id/items/:itemId/decision
 * Solo admin y cajero. Decide una línea en estado 'propuesta' hacia 'aprobada' o 'rechazada'.
 */
export async function decideOrderItem(workOrderId, itemId, { decision, channel } = {}, companyId, { userId } = {}) {
  if (!['aprobada', 'rechazada'].includes(decision)) {
    throw new AppError('La decisión debe ser "aprobada" o "rechazada".', 'INVALID_FIELD', 422);
  }
  if (!DECISION_CHANNELS.includes(channel)) {
    throw new AppError(
      `El canal de decisión ("channel") debe ser uno de: ${DECISION_CHANNELS.join(', ')}.`,
      'INVALID_FIELD',
      422
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: woRows } = await client.query(
      `SELECT id, status FROM work_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [workOrderId, companyId]
    );
    const wo = woRows[0];
    if (!wo) {
      throw new AppError(`Orden de trabajo #${workOrderId} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
    }
    if (!EDITABLE_ITEM_WO_STATUSES.includes(wo.status)) {
      throw new AppError(
        `No se pueden decidir líneas cuando la OT está en estado '${wo.status}'.`,
        'INVALID_TRANSITION',
        422
      );
    }

    const { rows: itemRows } = await client.query(
      `SELECT * FROM work_order_items
       WHERE id = $1 AND work_order_id = $2 AND company_id = $3
       FOR UPDATE`,
      [itemId, workOrderId, companyId]
    );
    const existing = itemRows[0];
    if (!existing) {
      throw new AppError(
        `Línea #${itemId} no encontrada en la orden #${workOrderId}.`,
        'WORK_ORDER_ITEM_NOT_FOUND',
        404
      );
    }
    if (existing.status !== 'propuesta') {
      throw new AppError(
        `La línea #${itemId} ya fue decidida (estado actual: '${existing.status}').`,
        'INVALID_TRANSITION',
        422
      );
    }

    await client.query(
      `UPDATE work_order_items
       SET status           = $1,
           decided_by       = $2,
           decided_at       = NOW(),
           decision_channel = $3,
           updated_at       = NOW()
       WHERE id = $4 AND company_id = $5`,
      [decision, userId ?? null, channel, existing.id, companyId]
    );

    const { derivedTotal, updatedWorkOrder } = await recalculateAdditionalCostInTx(client, wo.id, companyId);

    await logAudit(client, {
      companyId,
      userId: userId ?? null,
      entity: 'work_order_item',
      entityId: existing.id,
      action: 'update',
      changes: {
        work_order_id: wo.id,
        status: { old: 'propuesta', new: decision },
        decision_channel: channel,
        additional_cost: derivedTotal,
      },
    });

    const itemsMap = await fetchItemsByWorkOrderIds([wo.id], companyId, client);
    const allItems = itemsMap.get(wo.id) || [];
    const updatedItem = allItems.find((it) => it.id === existing.id);

    await client.query('COMMIT');

    return {
      item: updatedItem,
      summary: buildWorkOrderItemsSummary(allItems),
      work_order: updatedWorkOrder,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /api/workorders/:id/items/notify-link
 * Reutiliza el mecanismo de consentimiento whatsapp_opt_in y wa.me del sistema:
 * arma el mensaje con las líneas en estado 'propuesta' y su total con IGV,
 * registra una fila en notifications y retorna el enlace sin enviarlo automáticamente.
 */
export async function createOrderItemsNotifyLink(workOrderId, companyId, _actor = {}) {
  const { rows: woRows } = await pool.query(
    `SELECT wo.id, wo.status,
            v.placa, v.customer_name, v.customer_phone, v.whatsapp_opt_in,
            c.igv_rate, c.nombre_comercial, c.razon_social
     FROM   work_orders wo
     JOIN   vehicles v  ON v.id = wo.vehicle_id
     JOIN   companies c ON c.id = wo.company_id
     WHERE  wo.id = $1 AND wo.company_id = $2`,
    [workOrderId, companyId]
  );
  const wo = woRows[0];
  if (!wo) {
    throw new AppError(`Orden de trabajo #${workOrderId} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
  }

  const itemsMap = await fetchItemsByWorkOrderIds([wo.id], companyId);
  const items = itemsMap.get(wo.id) || [];
  const pending = items.filter((it) => it.status === 'propuesta');
  if (pending.length === 0) {
    throw new AppError(
      'No hay líneas pendientes por aprobar en esta orden para notificar.',
      'INVALID_TRANSITION',
      422
    );
  }

  if (!wo.whatsapp_opt_in) {
    throw new AppError(
      'El cliente no autorizó recibir avisos por WhatsApp para este vehículo.',
      'WHATSAPP_NOT_ELIGIBLE',
      422
    );
  }

  const phone = normalizePhonePE(wo.customer_phone);
  if (!phone) {
    throw new AppError(
      'El cliente no tiene un número de celular peruano válido (9 dígitos) registrado.',
      'WHATSAPP_NOT_ELIGIBLE',
      422
    );
  }

  const igvRate = wo.igv_rate != null ? Number(wo.igv_rate) : 0.18;
  const pendingSubtotal = round2(
    pending.reduce((acc, it) => acc + round2(Number(it.unit_price) * Number(it.quantity)), 0)
  );
  const pendingIgv = round2(pendingSubtotal * igvRate);
  const pendingTotal = round2(pendingSubtotal + pendingIgv);

  const cliente = wo.customer_name ? String(wo.customer_name).trim() : '';
  const placa = wo.placa ? String(wo.placa).trim().toUpperCase() : '';
  const taller = (wo.nombre_comercial || wo.razon_social || '').trim();
  const saludo = cliente ? `Hola ${cliente}` : 'Hola';
  const refMoto = placa ? `tu moto ${placa}` : 'tu moto';
  const enTaller = taller ? ` en ${taller}` : '';

  const linesText = pending
    .map((it) => {
      const sub = round2(Number(it.unit_price) * Number(it.quantity)).toFixed(2);
      return `• ${it.display_name} x${it.quantity}: S/ ${sub}`;
    })
    .join('\n');

  const igvPct = Math.round(igvRate * 100);
  const message =
    `${saludo}, para continuar con ${refMoto}${enTaller}, requerimos tu aprobación de:\n` +
    `${linesText}\n` +
    `Subtotal: S/ ${pendingSubtotal.toFixed(2)} + IGV (${igvPct}%): S/ ${pendingIgv.toFixed(2)} = Total: S/ ${pendingTotal.toFixed(2)}\n` +
    `Por favor confírmanos si autorizas estos trabajos adicionales.`;

  const { rows: notifRows } = await pool.query(
    `INSERT INTO notifications (company_id, work_order_id, message, channel, status, event)
     VALUES ($1, $2, $3, 'whatsapp', 'pending', $4)
     RETURNING id`,
    [companyId, wo.id, message, WHATSAPP_EVENTS.PENDIENTE_APROBACION]
  );

  return {
    notification_id: notifRows[0].id,
    url: `https://wa.me/${phone}?text=${encodeURIComponent(message)}`,
    phone,
    message,
    pending_count: pending.length,
    pending_subtotal: pendingSubtotal,
    pending_igv: pendingIgv,
    pending_total: pendingTotal,
  };
}
