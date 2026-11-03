import { login } from './auth.service.js';

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, message, status, code) =>
  res.status(status).json({
    success: false,
    error: { message, ...(code ? { code } : {}) },
  });

/**
 * POST /api/auth/login
 */
export async function loginHandler(req, res, next) {
  try {
    const result = await login(req.body);
    ok(res, result);
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS') return fail(res, err.message, 401, err.code);
    if (err.code === 'COMPANY_INACTIVE') return fail(res, err.message, 403, err.code);
    next(err);
  }
}

/**
 * GET /api/auth/me  (requiere authenticate middleware)
 * Simplemente devuelve el payload ya cargado en req.user.
 */
export function getMe(req, res) {
  ok(res, req.user);
}
