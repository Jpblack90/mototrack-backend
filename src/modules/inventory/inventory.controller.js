import * as inventoryService from './inventory.service.js';
import { analyzeProductImage } from './inventory.aiClient.js';

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

// ─── Fase 8: Escaneo con IA ───────────────────────────────────────────────────

/**
 * POST /api/inventory/scan  (RF-01)
 *
 * Analiza la imagen de un repuesto con Gemini y devuelve una sugerencia.
 * NUNCA escribe en la base de datos. La creación real usa POST /api/inventory.
 *
 * Body: { image_base64: string, mime_type: string }
 *
 * requires_confirmation: true cuando confidence < 80 (mismo patrón que
 * requiresApproval en workorders — el frontend debe pedir confirmación al usuario
 * antes de usar los datos sugeridos para crear el producto).
 */
export async function scanProduct(req, res, next) {
  try {
    const { image_base64, mime_type } = req.body;

    // Validación de presencia — ANTES de tocar la IA
    if (!image_base64 || !mime_type) {
      return fail(
        res,
        '"image_base64" y "mime_type" son obligatorios en el body.',
        422
      );
    }

    // Validación de tamaño: base64 → bytes originales ≈ base64.length * 0.75
    const estimatedBytes = Math.ceil(image_base64.length * 0.75);
    const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
    if (estimatedBytes > MAX_BYTES) {
      return fail(res, 'Imagen demasiado grande (máximo 10 MB).', 422);
    }

    // Llamada a Gemini — puede lanzar AppError AI_SERVICE_ERROR
    const result = await analyzeProductImage({
      imageBase64: image_base64,
      mimeType:    mime_type,
    });

    ok(res, {
      detected_name:         result.detected_name,
      detected_brand:        result.detected_brand,
      confidence:            result.confidence,
      latency_ms:            result.latency_ms,
      // Si confidence < 80 el frontend debe mostrar un aviso de confirmación
      // antes de usar los datos sugeridos para registrar el producto.
      requires_confirmation: result.confidence < 80,
      // Conveniencia para el frontend: campos listos para pre-llenar el formulario
      suggested_product: {
        name:                result.detected_name,
        brand:               result.detected_brand,
        ai_confidence:       result.confidence,
        registration_method: 'ia',
      },
    });
  } catch (err) {
    if (err.code === 'AI_SERVICE_ERROR') return fail(res, err.message, 503);
    next(err);
  }
}
