import * as svc from './invoicing.service.js';

// ─── Formato de respuesta uniforme ───────────────────────────────────────────

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res, message, status = 400) =>
  res.status(status).json({ success: false, error: { message } });

function httpStatus(code) {
  const map = {
    SALE_NOT_FOUND:               404,
    INVOICE_NOT_FOUND:            404,
    CANNOT_INVOICE_VOIDED_SALE:   422,
    NOTHING_TO_RETRY:             422,
    MISSING_FIELD:                422,
    INVALID_FIELD:                422,
  };
  return map[code] ?? 500;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/invoicing/pending
 */
export async function getPendingContingency(req, res, next) {
  try {
    const invoices = await svc.getPendingContingency();
    ok(res, invoices);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/invoicing
 * GET /api/invoicing?estado=contingency
 */
export async function getAllInvoices(req, res, next) {
  try {
    const { estado } = req.query;
    const invoices = await svc.getAll({ estado });
    ok(res, invoices);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/invoicing/:id
 */
export async function getInvoice(req, res, next) {
  try {
    const invoice = await svc.getById(req.params.id);
    if (!invoice) return fail(res, `Invoice #${req.params.id} no encontrado.`, 404);
    ok(res, invoice);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/invoicing/:id/status   (RF-30)
 */
export async function getStatus(req, res, next) {
  try {
    const status = await svc.getStatus(req.params.id);
    ok(res, status);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code));
    next(err);
  }
}

/**
 * GET /api/invoicing/:id/ticket
 */
export async function getTicketData(req, res, next) {
  try {
    const ticket = await svc.getTicketData(req.params.id);
    ok(res, ticket);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code));
    next(err);
  }
}

/**
 * POST /api/invoicing
 * Body: { sale_id, comprobante_type, customer_document_type?, customer_document_number?, simulatePseDown? }
 */
export async function createInvoice(req, res, next) {
  try {
    const invoice = await svc.createInvoice(req.body);
    // Si ya existía (idempotencia RF-29), responder 200 no 201
    const httpCode = invoice.alreadyExists ? 200 : 201;
    ok(res, invoice, httpCode);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code));
    next(err);
  }
}

/**
 * PATCH /api/invoicing/:id/retry
 */
export async function retryContingency(req, res, next) {
  try {
    const invoice = await svc.retryContingency(req.params.id);
    ok(res, invoice);
  } catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code));
    next(err);
  }
}
