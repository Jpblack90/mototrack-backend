import * as svc from './workorders.service.js';

// ─── Formato de respuesta uniforme ───────────────────────────────────────────

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res, message, status = 400, code = null) =>
  res.status(status).json({ success: false, error: { message, ...(code ? { code } : {}) } });

/**
 * Traduce el .code de AppError al HTTP status correspondiente.
 * Cualquier código no mapeado explícitamente se convierte en 500.
 */
function httpStatusFromCode(code) {
  const map = {
    WORK_ORDER_NOT_FOUND:        404,
    VEHICLE_NOT_FOUND:           404,
    MECHANIC_NOT_FOUND:          404,
    WORK_ORDER_NOT_ASSIGNED:     403,
    STATUS_NOT_ALLOWED_FOR_ROLE: 403,
    APPROVAL_REQUIRED:           403,
    INVALID_TRANSITION:          422,
    MISSING_FIELD:               422,
    INVALID_FIELD:               422,
    INVALID_PHONE:               422,
    INVALID_MECHANIC:            422,  // RETROFIT Fase 6
  };
  return map[code] ?? 500;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/workorders/placa/:placa   — historial por placa (RF-14)
 */
export async function getHistoryByPlaca(req, res, next) {
  try {
    const history = await svc.getHistoryByPlaca(req.params.placa, req.user.company_id);
    ok(res, history);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/workorders
 * GET /api/workorders?status=recibido
 * GET /api/workorders?assigned=me
 */
export async function getAllOrders(req, res, next) {
  try {
    const { status, assigned } = req.query;
    const mechanicId = assigned === 'me' ? req.user.id : undefined;
    const orders = await svc.getAll({ status, mechanicId }, req.user.company_id);
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
    const order = await svc.getById(req.params.id, req.user.company_id);
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
    const newOrder = await svc.createWorkOrder(req.body, req.user.company_id);
    ok(res, newOrder, 201);
  } catch (err) {
    if (err.statusCode || err.code) {
      return fail(res, err.message, err.statusCode || httpStatusFromCode(err.code));
    }
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
    const updated = await svc.assignMechanic(req.params.id, mechanic_id, req.user.company_id);
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
    const result = await svc.updateStatus(
      req.params.id,
      status.trim(),
      {
        diagnosis_notes,
        additional_cost,
      },
      req.user.company_id,
      { userRole: req.user.role, userId: req.user.id }
    );
    ok(res, result);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatusFromCode(err.code), err.code);
    next(err);
  }
}

/**
 * PATCH /api/workorders/:id/approve  — UC-03 FA-1
 */
export async function approveAdditionalWork(req, res, next) {
  try {
    const result = await svc.approveAdditionalWork(req.params.id, req.user.company_id);
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
    const result = await svc.rejectAdditionalWork(req.params.id, req.user.company_id);
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
    const result = await svc.markNotPickedUp(req.params.id, req.user.company_id);
    ok(res, result);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatusFromCode(err.code));
    next(err);
  }
}

/**
 * GET /api/workorders/pickup-alerts
 * Admin y cajero: devuelve { not_picked_up, due_soon } (RF-17).
 */
export async function getPickupAlerts(req, res, next) {
  try {
    const alerts = await svc.getPickupAlerts(req.user.company_id);
    ok(res, alerts);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/workorders/:id/notifications
 * Admin y cajero: lista el historial de avisos de la orden de trabajo (RF-15).
 */
export async function getOrderNotifications(req, res, next) {
  try {
    const data = await svc.getOrderNotifications(req.params.id, req.user.company_id);
    ok(res, data);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatusFromCode(err.code));
    next(err);
  }
}
