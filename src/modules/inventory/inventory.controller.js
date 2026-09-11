import * as inventoryService from './inventory.service.js';

// ─── Formato de respuesta uniforme ───────────────────────────────────────────

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res, message, status = 400) =>
  res.status(status).json({ success: false, error: { message } });

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/inventory
 * GET /api/inventory?search=filtro
 */
export async function getAllItems(req, res, next) {
  try {
    const { search } = req.query;
    const items = await inventoryService.getAll({ search });
    ok(res, items);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/inventory/:id
 */
export async function getItem(req, res, next) {
  try {
    const item = await inventoryService.getById(req.params.id);
    if (!item) return fail(res, 'Producto no encontrado.', 404);
    ok(res, item);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/inventory
 */
export async function createItem(req, res, next) {
  try {
    const newItem = await inventoryService.create(req.body);
    ok(res, newItem, 201);
  } catch (err) {
    if (err.code === 'NEGATIVE_MARGIN') return fail(res, err.message, 422);
    if (err.code === 'MISSING_FIELD')   return fail(res, err.message, 400);
    if (err.code === 'INVALID_FIELD')   return fail(res, err.message, 400);
    next(err);
  }
}

/**
 * PUT /api/inventory/:id
 */
export async function updateItem(req, res, next) {
  try {
    const updated = await inventoryService.update(req.params.id, req.body);
    if (!updated) return fail(res, 'Producto no encontrado.', 404);
    ok(res, updated);
  } catch (err) {
    if (err.code === 'NEGATIVE_MARGIN') return fail(res, err.message, 422);
    if (err.code === 'MISSING_FIELD')   return fail(res, err.message, 400);
    if (err.code === 'INVALID_FIELD')   return fail(res, err.message, 400);
    next(err);
  }
}

/**
 * DELETE /api/inventory/:id  (soft-delete)
 */
export async function deleteItem(req, res, next) {
  try {
    const deleted = await inventoryService.remove(req.params.id);
    if (!deleted) return fail(res, 'Producto no encontrado o ya estaba inactivo.', 404);
    ok(res, { id: Number(req.params.id), is_active: false });
  } catch (err) {
    next(err);
  }
}
