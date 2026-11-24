import * as svc from './dashboard.service.js';

const ok   = (res, data) => res.status(200).json({ success: true, data });
const fail = (res, message, status) => res.status(status).json({ success: false, error: { message } });

/**
 * GET /api/dashboard
 * Query params opcionales: ?from=2026-01-01&to=2026-12-31
 */
export async function getFullDashboard(req, res, next) {
  try {
    const { from, to } = req.query;
    const data = await svc.getFullDashboard({ from, to }, req.user.company_id);
    ok(res, data);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/sales
 * Query params opcionales: ?from=&to=
 */
export async function getSalesSummary(req, res, next) {
  try {
    const { from, to } = req.query;
    ok(res, await svc.getSalesSummary({ from, to }, req.user.company_id));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/sales-trend
 * Query params opcionales: ?days=30
 */
export async function getSalesTrend(req, res, next) {
  try {
    let days = 30;
    if (req.query.days !== undefined) {
      const raw = String(req.query.days).trim();
      if (!/^\d+$/.test(raw)) {
        return fail(res, 'El parámetro days debe ser un número entero entre 1 y 90.', 400);
      }
      const parsed = parseInt(raw, 10);
      if (parsed < 1 || parsed > 90) {
        return fail(res, 'El parámetro days debe ser un número entero entre 1 y 90.', 400);
      }
      days = parsed;
    }
    const data = await svc.getSalesTrend(days, req.user.company_id);
    ok(res, data);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/inventory
 */
export async function getInventorySummary(req, res, next) {
  try {
    ok(res, await svc.getInventorySummary(req.user.company_id));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/workorders
 */
export async function getWorkOrdersSummary(req, res, next) {
  try {
    ok(res, await svc.getWorkOrdersSummary(req.user.company_id));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/invoicing
 */
export async function getInvoicingSummary(req, res, next) {
  try {
    ok(res, await svc.getInvoicingSummary(req.user.company_id));
  } catch (err) {
    next(err);
  }
}
