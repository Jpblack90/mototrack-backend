import * as platformService from './platform.service.js';

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res, message, status, code) =>
  res.status(status).json({
    success: false,
    error: { message, ...(code ? { code } : {}) },
  });

function httpStatus(code) {
  const map = {
    INVALID_CREDENTIALS: 401,
    PLATFORM_NOT_CONFIGURED: 503,
    ADMIN_NOT_FOUND: 404,
    COMPANY_NOT_FOUND: 404,
    USER_NOT_FOUND: 404,
    NOT_FOUND: 404,
    PASSWORD_UNCHANGED: 422,
    MISSING_FIELD: 422,
    INVALID_FIELD: 422,
    INVALID_PASSWORD: 422,
    INVALID_REASON: 422,
    INVALID_INPUT: 422,
  };
  return map[code] ?? 500;
}

function handleControllerError(err, res, next) {
  if (err?.code) {
    return fail(res, err.message, err.statusCode || httpStatus(err.code), err.code);
  }
  return next(err);
}

/**
 * POST /api/platform/auth/login
 */
export async function loginHandler(req, res, next) {
  try {
    const result = await platformService.login(req.body || {});
    ok(res, result);
  } catch (err) {
    handleControllerError(err, res, next);
  }
}

/**
 * POST /api/platform/auth/change-password
 */
export async function changePasswordHandler(req, res, next) {
  try {
    const result = await platformService.changePassword(
      req.platformAdmin.id,
      req.body || {},
      req.ip || null
    );
    ok(res, result);
  } catch (err) {
    handleControllerError(err, res, next);
  }
}

/**
 * GET /api/platform/auth/me
 */
export function getMeHandler(req, res) {
  ok(res, req.platformAdmin);
}

/**
 * GET /api/platform/metrics
 */
export async function getMetricsHandler(_req, res, next) {
  try {
    const metrics = await platformService.getMetrics();
    ok(res, metrics);
  } catch (err) {
    handleControllerError(err, res, next);
  }
}

/**
 * GET /api/platform/companies?status=&search=
 */
export async function listCompaniesHandler(req, res, next) {
  try {
    const { status, search } = req.query;
    const companies = await platformService.listCompanies({ status, search });
    ok(res, companies);
  } catch (err) {
    handleControllerError(err, res, next);
  }
}

/**
 * GET /api/platform/companies/:id
 */
export async function getCompanyDetailHandler(req, res, next) {
  try {
    const detail = await platformService.getCompanyDetail(req.params.id);
    ok(res, detail);
  } catch (err) {
    handleControllerError(err, res, next);
  }
}

/**
 * POST /api/platform/companies/:id/users/:userId/reset-password
 */
export async function resetUserPasswordHandler(req, res, next) {
  try {
    const result = await platformService.resetCompanyUserPassword(
      req.params.id,
      req.params.userId,
      req.platformAdmin,
      req.ip || null
    );
    ok(res, result);
  } catch (err) {
    handleControllerError(err, res, next);
  }
}

/**
 * PATCH /api/platform/companies/:id/status
 */
export async function updateCompanyStatusHandler(req, res, next) {
  try {
    const updated = await platformService.updateCompanyStatus(
      req.params.id,
      req.body || {},
      req.platformAdmin,
      req.ip || null
    );
    ok(res, updated);
  } catch (err) {
    handleControllerError(err, res, next);
  }
}

/**
 * POST /api/platform/companies/:id/payments
 */
export async function registerPaymentHandler(req, res, next) {
  try {
    const result = await platformService.registerCompanyPayment(
      req.params.id,
      req.body || {},
      req.platformAdmin,
      req.ip || null
    );
    ok(res, result, 201);
  } catch (err) {
    handleControllerError(err, res, next);
  }
}

/**
 * GET /api/platform/audit?company_id=
 */
export async function getAuditHandler(req, res, next) {
  try {
    const { company_id, action, page, limit } = req.query;
    const result = await platformService.getPlatformAuditLogs({
      companyId: company_id,
      action,
      page,
      limit,
    });
    ok(res, result);
  } catch (err) {
    handleControllerError(err, res, next);
  }
}
