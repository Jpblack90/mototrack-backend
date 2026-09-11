import * as svc from './users.service.js';

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, message, status)    => res.status(status).json({ success: false, error: { message } });

function httpStatus(code) {
  const map = { USER_NOT_FOUND: 404, EMAIL_ALREADY_EXISTS: 422, MISSING_FIELD: 422, INVALID_FIELD: 422 };
  return map[code] ?? 500;
}

export async function getAllUsers(req, res, next) {
  try { ok(res, await svc.getAll()); } catch (err) { next(err); }
}

export async function getUser(req, res, next) {
  try {
    const user = await svc.getById(req.params.id);
    if (!user) return fail(res, `Usuario #${req.params.id} no encontrado.`, 404);
    ok(res, user);
  } catch (err) { next(err); }
}

export async function createUser(req, res, next) {
  try { ok(res, await svc.create(req.body), 201); }
  catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code));
    next(err);
  }
}

export async function updateUser(req, res, next) {
  try { ok(res, await svc.update(req.params.id, req.body)); }
  catch (err) {
    if (err.code) return fail(res, err.message, httpStatus(err.code));
    next(err);
  }
}

export async function removeUser(req, res, next) {
  try {
    const deleted = await svc.remove(req.params.id);
    if (!deleted) return fail(res, `Usuario #${req.params.id} no encontrado o ya inactivo.`, 404);
    ok(res, { id: Number(req.params.id), is_active: false });
  } catch (err) { next(err); }
}
