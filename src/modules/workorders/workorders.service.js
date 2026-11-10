import pool from '../../config/database.js';
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
    `INSERT INTO work_orders (company_id, vehicle_id, entry_mileage, checklist_notes)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [companyId, vehicle.id, Number(entry_mileage), checklist_notes ?? null]
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

  return { ...workOrder, vehicle };
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
           u.name AS mechanic_name
    FROM   work_orders wo
    JOIN   vehicles    v  ON v.id  = wo.vehicle_id
    LEFT JOIN users    u  ON u.id  = wo.mechanic_id
    WHERE  ${conditions.join(' AND ')}
    ORDER  BY wo.id ASC
  `;

  const { rows } = await pool.query(query, params);
  return rows;
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
            u.name AS mechanic_name
     FROM   work_orders wo
     JOIN   vehicles    v  ON v.id = wo.vehicle_id
     LEFT JOIN users    u  ON u.id = wo.mechanic_id
     WHERE  wo.id = $1 AND wo.company_id = $2`,
    [id, companyId]
  );
  return rows[0] ?? null;
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
            u.name AS mechanic_name
     FROM   work_orders wo
     JOIN   vehicles    v  ON v.id = wo.vehicle_id
     LEFT JOIN users    u  ON u.id = wo.mechanic_id
     WHERE  v.placa = $1 AND v.company_id = $2 AND wo.company_id = $2
     ORDER  BY wo.created_at DESC`,
    [placa.trim().toUpperCase(), companyId]
  );
  return rows;
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
export async function updateStatus(
  id,
  newStatus,
  { diagnosis_notes, additional_cost } = {},
  companyId,
  { userRole, userId } = {}
) {
  // a) Verificar que la OT existe en la empresa
  const current = await getById(id, companyId);
  if (!current) {
    throw new AppError(`Orden de trabajo #${id} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
  }

  // Restricciones para el rol mecanico (Tarea 14.1)
  if (userRole === 'mecanico') {
    if (!current.mechanic_id || Number(current.mechanic_id) !== Number(userId)) {
      throw new AppError('Esta orden no está asignada a ti.', 'WORK_ORDER_NOT_ASSIGNED', 403);
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

  // c) Regla RF-16: desviar a pendiente_aprobacion si el costo supera el umbral configurado de la empresa
  let resolvedStatus = newStatus;
  let requiresApproval = false;

  // Obtener el umbral de aprobación configurado para la empresa
  const { rows: compRows } = await pool.query(
    'SELECT approval_threshold FROM companies WHERE id = $1',
    [companyId]
  );
  const approvalThreshold = compRows[0] && compRows[0].approval_threshold != null
    ? Number(compRows[0].approval_threshold)
    : 100;

  if (
    currentStatus === 'diagnostico' &&
    newStatus === 'en_reparacion' &&
    additional_cost != null &&
    Number(additional_cost) > approvalThreshold
  ) {
    resolvedStatus = 'pendiente_aprobacion';
    requiresApproval = true;
  }

  // d) Si el estado destino es 'terminado', rellenar terminado_at
  const isTerminado = resolvedStatus === 'terminado';

  const { rows } = await pool.query(
    `UPDATE work_orders
     SET
       status          = $1,
       diagnosis_notes = COALESCE($2, diagnosis_notes),
       additional_cost = COALESCE($3, additional_cost),
       terminado_at    = CASE WHEN $4 THEN NOW() ELSE terminado_at END,
       updated_at      = NOW()
     WHERE id = $5 AND company_id = $6
     RETURNING *`,
    [
      resolvedStatus,
      diagnosis_notes ?? null,
      additional_cost != null ? Number(additional_cost) : null,
      isTerminado,
      id,
      companyId,
    ]
  );

  const updated = rows[0];

  // e) Notificar al cliente si aplica plantilla de WhatsApp (RF-15)
  if (resolvedStatus === 'pendiente_aprobacion') {
    await createWhatsAppNoticeIfEligible({
      workOrderId: id,
      companyId,
      event: WHATSAPP_EVENTS.PENDIENTE_APROBACION,
      params: { monto: additional_cost ?? updated.additional_cost },
    });
  } else if (resolvedStatus === 'terminado') {
    await createWhatsAppNoticeIfEligible({
      workOrderId: id,
      companyId,
      event: WHATSAPP_EVENTS.TERMINADO,
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
    });
  }

  return { ...updated, requiresApproval };
}

/**
 * UC-03 FA-1: el cliente aprueba el trabajo adicional.
 * Solo válido si status === 'pendiente_aprobacion'.
 * Mueve a 'en_reparacion'.
 *
 * @param {number|string} id
 * @param {number}        companyId
 */
export async function approveAdditionalWork(id, companyId) {
  const current = await getById(id, companyId);
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

  const { rows } = await pool.query(
    `UPDATE work_orders
     SET status = 'en_reparacion', updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [id, companyId]
  );

  await notifyClient(id, 'El cliente aprobó el trabajo adicional. La reparación ha comenzado.', companyId);
  return rows[0];
}

/**
 * UC-03 FA-2: el cliente rechaza el trabajo adicional.
 * Solo válido si status === 'pendiente_aprobacion'.
 * Mueve a 'entregado' (cierre parcial).
 *
 * @param {number|string} id
 * @param {number}        companyId
 */
export async function rejectAdditionalWork(id, companyId) {
  const current = await getById(id, companyId);
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

  const { rows } = await pool.query(
    `UPDATE work_orders
     SET status = 'entregado', updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [id, companyId]
  );

  await notifyClient(
    id,
    'El cliente rechazó el trabajo adicional. El vehículo será devuelto con el diagnóstico realizado.',
    companyId
  );
  return rows[0];
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
