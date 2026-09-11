import * as svc from './workorders.service.js';

// ─── Formato de respuesta uniforme ───────────────────────────────────────────

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res, message, status = 400) =>
  res.status(status).json({ success: false, error: { message } });

/**
 * Traduce el .code de AppError al HTTP status correspondiente.
 * Cualquier código no mapeado explícitamente se convierte en 500.
 */
function httpStatusFromCode(code) {
  const map = {
    WORK_ORDER_NOT_FOUND: 404,
    VEHICLE_NOT_FOUND:    404,
    INVALID_TRANSITION:   422,
    MISSING_FIELD:        422,
    INVALID_FIELD:        422,
    INVALID_MECHANIC:     422,  // RETROFIT Fase 6
  };
  return map[code] ?? 500;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/workorders/placa/:placa   — historial por placa (RF-14)
 */
export async function getHistoryByPlaca(req, res, next) {
  try {
    const history = await svc.getHistoryByPlaca(req.params.placa);
    ok(res, history);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/workorders
 * GET /api/workorders?status=recibido
 */
export async function getAllOrders(req, res, next) {
  try {
    const { status } = req.query;
    const orders = await svc.getAll({ status });
    ok(res, orders);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/workorders/:id
 */
export async function getOrder(req, res, next) {
  try {
    const order = await svc.getById(req.params.id);
    if (!order) return fail(res, `Orden de trabajo #${req.params.id} no encontrada.`, 404);
    ok(res, order);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/workorders
 */
export async function createOrder(req, res, next) {
  try {
    const newOrder = await svc.createWorkOrder(req.body);
    ok(res, newOrder, 201);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatusFromCode(err.code));
    next(err);
  }
}

/**
 * PATCH /api/workorders/:id/assign
 * RETROFIT Fase 6: Body cambia de { "mechanic_name" } a { "mechanic_id" }
 * mechanic_id debe ser el id de un usuario con role='mecanico' activo.
 */
export async function assignMechanic(req, res, next) {
  try {
    const { mechanic_id } = req.body;
    if (!mechanic_id) {
      return fail(res, '"mechanic_id" es obligatorio en el body.', 422);
    }
    const updated = await svc.assignMechanic(req.params.id, mechanic_id);
    if (!updated) return fail(res, `Orden de trabajo #${req.params.id} no encontrada.`, 404);
    ok(res, updated);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatusFromCode(err.code));
    next(err);
  }
}

/**
 * PATCH /api/workorders/:id/status
 * Body: { "status": "en_reparacion", "diagnosis_notes": "...", "additional_cost": 150 }
 */
export async function updateStatus(req, res, next) {
  try {
    const { status, diagnosis_notes, additional_cost } = req.body;
    if (!status || String(status).trim() === '') {
      return fail(res, '"status" es obligatorio en el body.', 422);
    }
    const result = await svc.updateStatus(req.params.id, status.trim(), {
      diagnosis_notes,
      additional_cost,
    });
    ok(res, result);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatusFromCode(err.code));
    next(err);
  }
}

/**
 * PATCH /api/workorders/:id/approve  — UC-03 FA-1
 */
export async function approveAdditionalWork(req, res, next) {
  try {
    const result = await svc.approveAdditionalWork(req.params.id);
    ok(res, result);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatusFromCode(err.code));
    next(err);
  }
}

/**
 * PATCH /api/workorders/:id/reject   — UC-03 FA-2
 */
export async function rejectAdditionalWork(req, res, next) {
  try {
    const result = await svc.rejectAdditionalWork(req.params.id);
    ok(res, result);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatusFromCode(err.code));
    next(err);
  }
}

/**
 * PATCH /api/workorders/:id/not-picked-up
 */
export async function markNotPickedUp(req, res, next) {
  try {
    const result = await svc.markNotPickedUp(req.params.id);
    ok(res, result);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatusFromCode(err.code));
    next(err);
  }
}
