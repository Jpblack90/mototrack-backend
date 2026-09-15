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
    const data = await svc.getFullDashboard({ from, to });
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
    ok(res, await svc.getSalesSummary({ from, to }));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/inventory
 */
export async function getInventorySummary(req, res, next) {
  try {
    ok(res, await svc.getInventorySummary());
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/workorders
 */
export async function getWorkOrdersSummary(req, res, next) {
  try {
    ok(res, await svc.getWorkOrdersSummary());
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/invoicing
 */
export async function getInvoicingSummary(req, res, next) {
  try {
    ok(res, await svc.getInvoicingSummary());
  } catch (err) {
    next(err);
  }
}
