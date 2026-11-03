import * as svc from './users.service.js';

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, message, status, code) =>
  res.status(status).json({
    success: false,
    error: { message, ...(code ? { code } : {}) },
  });

function httpStatus(code) {
  const map = {
    USER_NOT_FOUND: 404,
    EMAIL_ALREADY_EXISTS: 409,
    SELF_DEACTIVATION_PROHIBITED: 409,
    SELF_DEMOTION_PROHIBITED: 409,
    LAST_ADMIN_PROTECTED: 409,
    MISSING_FIELD: 422,
    INVALID_FIELD: 422,
    INVALID_PASSWORD: 422,
  };
  return map[code] ?? 500;
}

export async function getAllUsers(req, res, next) {
  try {
    ok(res, await svc.getAll(req.user.company_id));
  } catch (err) {
    next(err);
  }
}

export async function getUser(req, res, next) {
  try {
    const user = await svc.getById(req.params.id, req.user.company_id);
    if (!user) return fail(res, `Usuario #${req.params.id} no encontrado.`, 404, 'USER_NOT_FOUND');
    ok(res, user);
  } catch (err) {
    next(err);
  }
}

export async function createUser(req, res, next) {
  try {
    const user = await svc.create(req.body, req.user.company_id, req.user.id);
    ok(res, user, 201);
  } catch (err) {
    if (err.code) return fail(res, err.message, err.statusCode || httpStatus(err.code), err.code);
    next(err);
  }
}

export async function updateUser(req, res, next) {
  try {
    const user = await svc.update(req.params.id, req.body, req.user.company_id, req.user.id);
    ok(res, user);
  } catch (err) {
    if (err.code) return fail(res, err.message, err.statusCode || httpStatus(err.code), err.code);
    next(err);
  }
}

export async function removeUser(req, res, next) {
  try {
    const deleted = await svc.remove(req.params.id, req.user.company_id, req.user.id);
    if (!deleted) return fail(res, `Usuario #${req.params.id} no encontrado o ya inactivo.`, 404, 'USER_NOT_FOUND');
    ok(res, { id: Number(req.params.id), is_active: false });
  } catch (err) {
    if (err.code) return fail(res, err.message, err.statusCode || httpStatus(err.code), err.code);
    next(err);
  }
}

export async function resetUserPassword(req, res, next) {
  try {
    const user = await svc.resetPassword(req.params.id, req.body, req.user.company_id, req.user.id);
    ok(res, {
      id: user.id,
      must_change_password: user.must_change_password,
      message: 'Contraseña restablecida exitosamente.',
    });
  } catch (err) {
    if (err.code) return fail(res, err.message, err.statusCode || httpStatus(err.code), err.code);
    next(err);
  }
}
