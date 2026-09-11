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

/**
 * RF-16: monto (en soles) a partir del cual una reparación adicional
 * requiere aprobación explícita del cliente antes de ejecutarse.
 */
export const APPROVAL_THRESHOLD = 100;

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
async function notifyClient(workOrderId, message) {
  console.log(`📩 [STUB] Notificación a cliente — OT #${workOrderId}: ${message}`);

  await pool.query(
    `INSERT INTO notifications (work_order_id, message, channel)
     VALUES ($1, $2, $3)`,
    [workOrderId, message, 'stub']
  );
}

// ─── Vehículos ────────────────────────────────────────────────────────────────

/**
 * Busca un vehículo por placa.
 * - Si existe: actualiza con COALESCE los campos enviados y retorna el vehículo.
 * - Si no existe: lo crea y retorna el vehículo nuevo.
 *
 * @param {{ placa, brand, model, customer_name, customer_phone }} param0
 * @returns {object} vehicle row
 */
export async function findOrCreateVehicle({ placa, brand, model, customer_name, customer_phone }) {
  // Buscar por placa
  const found = await pool.query(
    `SELECT * FROM vehicles WHERE placa = $1`,
    [placa]
  );

  if (found.rows.length > 0) {
    // Ya existe: actualizar campos no nulos con COALESCE
    const { rows } = await pool.query(
      `UPDATE vehicles
       SET
         brand          = COALESCE($1, brand),
         model          = COALESCE($2, model),
         customer_name  = COALESCE($3, customer_name),
         customer_phone = COALESCE($4, customer_phone)
       WHERE placa = $5
       RETURNING *`,
      [brand ?? null, model ?? null, customer_name ?? null, customer_phone ?? null, placa]
    );
    return rows[0];
  }

  // No existe: crear
  const { rows } = await pool.query(
    `INSERT INTO vehicles (placa, brand, model, customer_name, customer_phone)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [placa, brand ?? null, model ?? null, customer_name, customer_phone ?? null]
  );
  return rows[0];
}

// ─── Órdenes de Trabajo ───────────────────────────────────────────────────────

/**
 * Crea una nueva OT en estado 'recibido'.
 * Llama a findOrCreateVehicle internamente.
 *
 * Campos obligatorios: placa, customer_name, entry_mileage.
 *
 * @param {object} data
 * @throws {AppError} si falta algún campo obligatorio
 */
export async function createWorkOrder(data) {
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
  });

  const { rows } = await pool.query(
    `INSERT INTO work_orders (vehicle_id, entry_mileage, checklist_notes)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [vehicle.id, Number(entry_mileage), checklist_notes ?? null]
  );

  return { ...rows[0], vehicle };
}

/**
 * Lista todas las OT con datos del vehículo asociado.
 * Filtra por status si se envía.
 *
 * @param {{ status?: string }} options
 */
export async function getAll({ status } = {}) {
  let query;
  let params;

  if (status && status.trim() !== '') {
    query = `
      SELECT wo.*, v.placa, v.brand, v.model, v.customer_name, v.customer_phone
      FROM   work_orders wo
      JOIN   vehicles    v  ON v.id = wo.vehicle_id
      WHERE  wo.status = $1
      ORDER  BY wo.id ASC
    `;
    params = [status.trim()];
  } else {
    query = `
      SELECT wo.*, v.placa, v.brand, v.model, v.customer_name, v.customer_phone
      FROM   work_orders wo
      JOIN   vehicles    v  ON v.id = wo.vehicle_id
      ORDER  BY wo.id ASC
    `;
    params = [];
  }

  const { rows } = await pool.query(query, params);
  return rows;
}

/**
 * Retorna una OT por id con datos del vehículo.
 * @param {number|string} id
 * @returns {object|null}
 */
export async function getById(id) {
  const { rows } = await pool.query(
    `SELECT wo.*, v.placa, v.brand, v.model, v.customer_name, v.customer_phone
     FROM   work_orders wo
     JOIN   vehicles    v  ON v.id = wo.vehicle_id
     WHERE  wo.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * RF-14: historial de OT de un vehículo, ordenado de más reciente a más antiguo.
 * @param {string} placa
 * @returns {object[]}
 */
export async function getHistoryByPlaca(placa) {
  const { rows } = await pool.query(
    `SELECT wo.*, v.placa, v.brand, v.model, v.customer_name, v.customer_phone
     FROM   work_orders wo
     JOIN   vehicles    v  ON v.id = wo.vehicle_id
     WHERE  v.placa = $1
     ORDER  BY wo.created_at DESC`,
    [placa.trim().toUpperCase()]
  );
  return rows;
}

/**
 * Asigna un mecánico a una OT.
 * @param {number|string} id
 * @param {string}        mechanic_name
 * @returns {object|null}
 */
export async function assignMechanic(id, mechanic_name) {
  const { rows } = await pool.query(
    `UPDATE work_orders
     SET mechanic_name = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [mechanic_name, id]
  );
  return rows[0] ?? null;
}

/**
 * Actualiza el estado de una OT aplicando la máquina de estados.
 *
 * Reglas especiales:
 *   - Si diagnostico → en_reparacion Y additional_cost > APPROVAL_THRESHOLD:
 *     el estado real se desvía a 'pendiente_aprobacion' (RF-16 / UC-03 FA-1).
 *   - Si el nuevo estado es 'terminado', se rellena terminado_at (RF-17).
 *
 * @param {number|string} id
 * @param {string}        newStatus
 * @param {{ diagnosis_notes?: string, additional_cost?: number }} extras
 */
export async function updateStatus(id, newStatus, { diagnosis_notes, additional_cost } = {}) {
  // a) Verificar que la OT existe
  const current = await getById(id);
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

  // c) Regla RF-16: desviar a pendiente_aprobacion si el costo supera el umbral
  let resolvedStatus = newStatus;
  let requiresApproval = false;

  if (
    currentStatus === 'diagnostico' &&
    newStatus === 'en_reparacion' &&
    additional_cost != null &&
    Number(additional_cost) > APPROVAL_THRESHOLD
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
     WHERE id = $5
     RETURNING *`,
    [
      resolvedStatus,
      diagnosis_notes ?? null,
      additional_cost != null ? Number(additional_cost) : null,
      isTerminado,
      id,
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

  await notifyClient(id, notificationMsg);

  return { ...updated, requiresApproval };
}

/**
 * UC-03 FA-1: el cliente aprueba el trabajo adicional.
 * Solo válido si status === 'pendiente_aprobacion'.
 * Mueve a 'en_reparacion'.
 *
 * @param {number|string} id
 */
export async function approveAdditionalWork(id) {
  const current = await getById(id);
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
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  await notifyClient(id, 'El cliente aprobó el trabajo adicional. La reparación ha comenzado.');
  return rows[0];
}

/**
 * UC-03 FA-2: el cliente rechaza el trabajo adicional.
 * Solo válido si status === 'pendiente_aprobacion'.
 * Mueve a 'entregado' (cierre parcial).
 *
 * @param {number|string} id
 */
export async function rejectAdditionalWork(id) {
  const current = await getById(id);
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
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  await notifyClient(
    id,
    'El cliente rechazó el trabajo adicional. El vehículo será devuelto con el diagnóstico realizado.'
  );
  return rows[0];
}

/**
 * Marca una OT como 'no_recogido'.
 * Solo válido si status === 'terminado'.
 *
 * ⚠️  VERIFICACIÓN MANUAL por ahora.
 *   La revisión automática por plazo vencido (cron job que corra a medianoche
 *   y mueva todas las OT 'terminado' con más de X días a 'no_recogido') queda
 *   para una fase de infraestructura futura. No se implementa hoy.
 *
 * @param {number|string} id
 */
export async function markNotPickedUp(id) {
  const current = await getById(id);
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
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  // No se dispara notifyClient aquí: el cliente no recoge, la tienda decide si contactar
  return rows[0];
}
