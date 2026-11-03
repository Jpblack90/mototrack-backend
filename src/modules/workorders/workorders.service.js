import pool from '../../config/database.js';

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
  no_recogido:           [],
};

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Stub de notificación al cliente.
 *
 * ⚠️  PUNTO DE INTEGRACIÓN FUTURA:
 *   Reemplazar el console.log y el channel 'stub' por una llamada real a
 *   Twilio SMS / WhatsApp Business API.
 *   La estructura de la tabla `notifications` ya está preparada para soportar
 *   múltiples canales sin cambios de esquema.
 *
 * @param {number} workOrderId
 * @param {string} message
 */
async function notifyClient(workOrderId, message, companyId) {
  console.log(`📩 [STUB] Notificación a cliente — OT #${workOrderId} (Empresa ${companyId}): ${message}`);

  await pool.query(
    `INSERT INTO notifications (company_id, work_order_id, message, channel)
     VALUES ($1, $2, $3, $4)`,
    [companyId, workOrderId, message, 'stub']
  );
}

// ─── Vehículos ────────────────────────────────────────────────────────────────

/**
 * Busca un vehículo por placa dentro de la empresa.
 * - Si existe: actualiza con COALESCE los campos enviados y retorna el vehículo.
 * - Si no existe: lo crea con su company_id y retorna el vehículo nuevo.
 *
 * @param {{ placa, brand, model, customer_name, customer_phone }} param0
 * @param {number} companyId
 * @returns {object} vehicle row
 */
export async function findOrCreateVehicle({ placa, brand, model, customer_name, customer_phone }, companyId) {
  // Buscar por placa y empresa
  const found = await pool.query(
    `SELECT * FROM vehicles WHERE placa = $1 AND company_id = $2`,
    [placa, companyId]
  );

  if (found.rows.length > 0) {
    // Ya existe en esta empresa: actualizar campos no nulos con COALESCE
    const { rows } = await pool.query(
      `UPDATE vehicles
       SET
         brand          = COALESCE($1, brand),
         model          = COALESCE($2, model),
         customer_name  = COALESCE($3, customer_name),
         customer_phone = COALESCE($4, customer_phone)
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [brand ?? null, model ?? null, customer_name ?? null, customer_phone ?? null, found.rows[0].id, companyId]
    );
    return rows[0];
  }

  // No existe: crear vinculado a la empresa
  const { rows } = await pool.query(
    `INSERT INTO vehicles (company_id, placa, brand, model, customer_name, customer_phone)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [companyId, placa, brand ?? null, model ?? null, customer_name, customer_phone ?? null]
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
  const { placa, brand, model, customer_name, customer_phone, entry_mileage, checklist_notes } =
    data;

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

  const vehicle = await findOrCreateVehicle({
    placa: placa.trim().toUpperCase(),
    brand,
    model,
    customer_name: customer_name.trim(),
    customer_phone,
  }, companyId);

  const { rows } = await pool.query(
    `INSERT INTO work_orders (company_id, vehicle_id, entry_mileage, checklist_notes)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [companyId, vehicle.id, Number(entry_mileage), checklist_notes ?? null]
  );

  return { ...rows[0], vehicle };
}

/**
 * Lista todas las OT de la empresa con datos del vehículo asociado.
 * Filtra por status si se envía.
 *
 * @param {{ status?: string }} options
 * @param {number}             companyId
 */
export async function getAll({ status } = {}, companyId) {
  let query;
  let params;

  if (status && status.trim() !== '') {
    query = `
      SELECT wo.*, v.placa, v.brand, v.model, v.customer_name, v.customer_phone,
             u.name AS mechanic_name
      FROM   work_orders wo
      JOIN   vehicles    v  ON v.id  = wo.vehicle_id
      LEFT JOIN users    u  ON u.id  = wo.mechanic_id
      WHERE  wo.company_id = $1 AND wo.status = $2
      ORDER  BY wo.id ASC
    `;
    params = [companyId, status.trim()];
  } else {
    query = `
      SELECT wo.*, v.placa, v.brand, v.model, v.customer_name, v.customer_phone,
             u.name AS mechanic_name
      FROM   work_orders wo
      JOIN   vehicles    v  ON v.id  = wo.vehicle_id
      LEFT JOIN users    u  ON u.id  = wo.mechanic_id
      WHERE  wo.company_id = $1
      ORDER  BY wo.id ASC
    `;
    params = [companyId];
  }

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
 */
export async function updateStatus(id, newStatus, { diagnosis_notes, additional_cost } = {}, companyId) {
  // a) Verificar que la OT existe en la empresa
  const current = await getById(id, companyId);
  if (!current) {
    throw new AppError(`Orden de trabajo #${id} no encontrada.`, 'WORK_ORDER_NOT_FOUND', 404);
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

  // e) Notificar al cliente
  let notificationMsg;
  if (requiresApproval) {
    notificationMsg =
      `Su OT ha sido diagnosticada. El costo adicional es S/ ${Number(additional_cost).toFixed(2)}, ` +
      `lo cual supera el umbral de aprobación. Por favor confirme para continuar la reparación.`;
  } else {
    notificationMsg = `El estado de su OT ha cambiado a: ${resolvedStatus}.`;
  }

  await notifyClient(id, notificationMsg, companyId);

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

  return rows[0];
}
