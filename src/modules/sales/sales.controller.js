import * as svc from './sales.service.js';

// ─── Formato de respuesta uniforme ───────────────────────────────────────────

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res, message, status = 400) =>
  res.status(status).json({ success: false, error: { message } });

/**
 * Mapea el .code de AppError al HTTP status correcto.
 */
function httpStatus(code) {
  const map = {
    SALE_NOT_FOUND:    404,
    PRODUCT_NOT_FOUND: 404,
    KIT_NOT_FOUND:     404,
    INSUFFICIENT_STOCK: 422,
    ALREADY_VOIDED:    422,
    INVALID_TRANSITION: 422,
    MISSING_FIELD:     422,
    INVALID_FIELD:     422,
    INVALID_ITEM:      422,
    KIT_EMPTY:         422,
  };
  return map[code] ?? 500;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/sales/kits
 */
export async function getAllKits(req, res, next) {
  try {
    const kits = await svc.getAllKits();
    ok(res, kits);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/sales/kits
 */
export async function createKit(req, res, next) {
  try {
    const kit = await svc.createKit(req.body);
    ok(res, kit, 201);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code));
    next(err);
  }
}

/**
 * GET /api/sales
 * GET /api/sales?status=voided
 */
export async function getAllSales(req, res, next) {
  try {
    const { status } = req.query;
    const sales = await svc.getAll({ status });
    ok(res, sales);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/sales/:id
 */
export async function getSale(req, res, next) {
  try {
    const sale = await svc.getById(req.params.id);
    if (!sale) return fail(res, `Venta #${req.params.id} no encontrada.`, 404);
    ok(res, sale);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/sales
 */
export async function createSale(req, res, next) {
  try {
    const sale = await svc.createSale(req.body);
    ok(res, sale, 201);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code));
    next(err);
  }
}

/**
 * PATCH /api/sales/:id/void
 * Body: { "void_reason": "Motivo de anulación" }
 */
export async function voidSale(req, res, next) {
  try {
    const { void_reason } = req.body;
    const sale = await svc.voidSale(req.params.id, void_reason);
    ok(res, sale);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code));
    next(err);
  }
}
