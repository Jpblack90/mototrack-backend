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
 * RETROFIT Fase 6: si force:true viene en el body, verifica que sea Admin
 * antes de tocar la BD. Pasa req.user.id al service para auditoría.
 */
export async function createItem(req, res, next) {
  try {
    // Guardia de rol para force:true — sin tocar la BD si no pasa
    if (req.body.force === true && req.user?.role !== 'admin') {
      return fail(res, 'Solo un Administrador puede forzar un margen negativo.', 403);
    }
    const newItem = await inventoryService.create(req.body, req.user?.id ?? null);
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
 * RETROFIT Fase 6: misma guardia de force:true que createItem.
 */
export async function updateItem(req, res, next) {
  try {
    // Guardia de rol para force:true — sin tocar la BD si no pasa
    if (req.body.force === true && req.user?.role !== 'admin') {
      return fail(res, 'Solo un Administrador puede forzar un margen negativo.', 403);
    }
    const updated = await inventoryService.update(req.params.id, req.body, req.user?.id ?? null);
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
