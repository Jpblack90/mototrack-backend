import * as svc from './sales.service.js';

// ─── Formato de respuesta uniforme ───────────────────────────────────────────

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res, message, status = 400, code = undefined) =>
  res.status(status).json({
    success: false,
    error: { message, ...(code ? { code } : {}) },
  });

/**
 * Mapea el .code de AppError al HTTP status correcto.
 */
function httpStatus(errOrCode) {
  if (typeof errOrCode === 'object' && errOrCode !== null) {
    if (errOrCode.statusCode) return errOrCode.statusCode;
    errOrCode = errOrCode.code;
  }
  const map = {
    SALE_NOT_FOUND:            404,
    PRODUCT_NOT_FOUND:         404,
    KIT_NOT_FOUND:             404,
    INVOICE_NOT_ACCEPTED:      409,
    ALREADY_VOIDED:            409,
    INSUFFICIENT_STOCK:        422,
    INVALID_TRANSITION:        422,
    MISSING_FIELD:             422,
    INVALID_FIELD:             422,
    INVALID_ITEM:              422,
    KIT_EMPTY:                 422,
    PAYMENT_MISMATCH:          422,
    INVALID_MOTIVO_FOR_BOLETA: 422,
  };
  return map[errOrCode] ?? 500;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/sales/kits
 */
export async function getAllKits(req, res, next) {
  try {
    const kits = await svc.getAllKits(req.user.company_id);
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
    const kit = await svc.createKit(req.body, req.user.company_id);
    ok(res, kit, 201);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code), err.code);
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
    const sales = await svc.getAll({ status }, req.user.company_id);
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
    const sale = await svc.getById(req.params.id, req.user.company_id);
    if (!sale) return fail(res, `Venta #${req.params.id} no encontrada.`, 404, 'SALE_NOT_FOUND');
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
    const sale = await svc.createSale(req.body, req.user.company_id);
    ok(res, sale, 201);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code), err.code);
    next(err);
  }
}

/**
 * PATCH /api/sales/:id/void
 * Body: { "void_reason": "Motivo de anulación", "motivo_code"?: "01"|"02"|"06" }
 */
export async function voidSale(req, res, next) {
  try {
    const { void_reason, motivo_code } = req.body;
    const forceFail =
      process.env.NODE_ENV !== 'production' &&
      (process.env.FORCE_VOID_FAIL === '1' ||
        req.headers['x-force-void-fail'] === '1' ||
        req.body?._force_void_fail === true);

    const sale = await svc.voidSale(
      req.params.id,
      { void_reason, motivo_code, forceFail },
      req.user.company_id,
      req.user?.id ?? null
    );
    ok(res, sale);
  } catch (err) {
    if (err.code || err.statusCode) return fail(res, err.message, httpStatus(err), err.code);
    next(err);
  }
}
