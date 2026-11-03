import { login, changePassword } from './auth.service.js';

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, message, status, code) =>
  res.status(status).json({
    success: false,
    error: { message, ...(code ? { code } : {}) },
  });

function httpStatus(code) {
  const map = {
    INVALID_CREDENTIALS: 401,
    COMPANY_INACTIVE: 403,
    USER_NOT_FOUND: 404,
    PASSWORD_UNCHANGED: 422,
    MISSING_FIELD: 422,
    INVALID_PASSWORD: 422,
  };
  return map[code] ?? 500;
}

/**
 * POST /api/auth/login
 */
export async function loginHandler(req, res, next) {
  try {
    const result = await login(req.body);
    ok(res, result);
  } catch (err) {
    if (err.code) return fail(res, err.message, err.statusCode || httpStatus(err.code), err.code);
    next(err);
  }
}

/**
 * GET /api/auth/me (requiere authenticate middleware)
 * Devuelve el payload cargado en req.user con el rol y must_change_password de la BD.
 */
export function getMe(req, res) {
  ok(res, req.user);
}

/**
 * POST /api/auth/change-password (requiere authenticate middleware)
 */
export async function changePasswordHandler(req, res, next) {
  try {
    const result = await changePassword(req.user.id, req.body);
    ok(res, result);
  } catch (err) {
    if (err.code) return fail(res, err.message, err.statusCode || httpStatus(err.code), err.code);
    next(err);
  }
}
