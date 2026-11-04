import * as inventoryService from './inventory.service.js';
import { analyzeProductImage } from './inventory.aiClient.js';
import { getUsage } from '../plans/plan.service.js';
import { recordUsage } from '../plans/aiUsage.service.js';

// ─── Formato de respuesta uniforme ───────────────────────────────────────────

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res, message, status = 400, code = undefined) =>
  res.status(status).json({
    success: false,
    error: {
      message,
      ...(code ? { code } : {}),
    },
  });

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/inventory
 * GET /api/inventory?search=filtro&compatible_with=modelo&stock_status=low|out
 */
export async function getAllItems(req, res, next) {
  try {
    const { search, compatible_with, stock_status } = req.query;
    const items = await inventoryService.getAll(
      { search, compatible_with, stock_status },
      req.user.company_id
    );
    ok(res, items);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/inventory/alerts
 * Solo admin, cajero y almacenero
 */
export async function getAlerts(req, res, next) {
  try {
    const alerts = await inventoryService.getAlerts(req.user.company_id);
    ok(res, alerts);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/inventory/:id/alternatives
 * GET /api/inventory/:id/alternatives?compatible_with=modelo
 */
export async function getAlternatives(req, res, next) {
  try {
    const alternatives = await inventoryService.getAlternatives(
      req.params.id,
      req.user.company_id,
      { compatible_with: req.query.compatible_with }
    );
    if (alternatives === null) return fail(res, 'Producto no encontrado.', 404);
    ok(res, alternatives);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/inventory/:id
 */
export async function getItem(req, res, next) {
  try {
    const item = await inventoryService.getById(req.params.id, req.user.company_id);
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
    const newItem = await inventoryService.create(req.body, req.user.company_id, req.user?.id ?? null);
    ok(res, newItem, 201);
  } catch (err) {
    if (err.code === 'NEGATIVE_MARGIN') return fail(res, err.message, 422);
    if (err.code === 'MISSING_FIELD')   return fail(res, err.message, 400);
    if (err.code === 'INVALID_FIELD')   return fail(res, err.message, err.statusCode || 422);
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
    const updated = await inventoryService.update(req.params.id, req.body, req.user.company_id, req.user?.id ?? null);
    if (!updated) return fail(res, 'Producto no encontrado.', 404);
    ok(res, updated);
  } catch (err) {
    if (err.code === 'NEGATIVE_MARGIN') return fail(res, err.message, 422);
    if (err.code === 'MISSING_FIELD')   return fail(res, err.message, 400);
    if (err.code === 'INVALID_FIELD')   return fail(res, err.message, err.statusCode || 422);
    next(err);
  }
}

/**
 * DELETE /api/inventory/:id  (soft-delete)
 */
export async function deleteItem(req, res, next) {
  try {
    const deleted = await inventoryService.remove(req.params.id, req.user.company_id, req.user?.id ?? null);
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

    const companyId = req.user?.company_id;
    const userId = req.user?.id;

    // Verificación de límite de escaneos IA del plan — ANTES de llamar a Gemini
    if (companyId) {
      const usage = await getUsage(companyId);
      const maxScans = usage.plan?.max_ai_scans_month;
      if (maxScans !== null && maxScans !== undefined && usage.ai_scans_this_month >= maxScans) {
        return fail(
          res,
          `Alcanzaste los ${maxScans} escaneos con IA de este mes. Puedes seguir registrando productos manualmente; el cupo se renueva el día 1.`,
          403,
          'PLAN_LIMIT_REACHED'
        );
      }
    }

    // Llamada a Gemini (función pura de IA sin SQL)
    const { data, usage } = await analyzeProductImage({
      imageBase64: image_base64,
      mimeType:    mime_type,
    });

    // Registro de consumo exitoso en ai_usage mediante el servicio
    if (companyId && usage) {
      await recordUsage({
        companyId,
        userId,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thinkingTokens: usage.thinkingTokens,
        latencyMs: usage.latencyMs,
        success: true,
        errorCode: null,
      });
    }

    ok(res, {
      detected_name:               data.detected_name,
      detected_brand:              data.detected_brand,
      confidence:                  data.confidence,
      latency_ms:                  data.latency_ms,
      // Si confidence < 80 el frontend debe mostrar un aviso de confirmación
      // antes de usar los datos sugeridos para registrar el producto.
      requires_confirmation:       data.confidence < 80,
      detected_category:           data.detected_category,
      suggested_compatible_models: data.suggested_compatible_models,
      compatibility_source:        data.compatibility_source,
      // Conveniencia para el frontend: campos listos para pre-llenar el formulario
      suggested_product: {
        name:                 data.detected_name,
        brand:                data.detected_brand,
        category:             data.detected_category,
        compatible_models:    data.suggested_compatible_models,
        compatibility_source: data.compatibility_source,
        ai_confidence:        data.confidence,
        registration_method:  'ia',
      },
    });
  } catch (err) {
    const companyId = req.user?.company_id;
    const userId = req.user?.id;

    // Registro de consumo fallido en ai_usage mediante el servicio
    if (companyId && err.usage) {
      await recordUsage({
        companyId,
        userId,
        model: err.usage.model,
        inputTokens: err.usage.inputTokens ?? 0,
        outputTokens: err.usage.outputTokens ?? 0,
        thinkingTokens: err.usage.thinkingTokens ?? 0,
        latencyMs: err.usage.latencyMs ?? 0,
        success: false,
        errorCode: err.code || err.usage.errorCode || 'AI_SERVICE_ERROR',
      });
    }

    if (
      err.code === 'AI_TIMEOUT' ||
      err.code === 'AI_NOT_CONFIGURED' ||
      err.code === 'AI_QUOTA' ||
      err.code === 'AI_SERVICE_ERROR'
    ) {
      return fail(res, err.message, err.statusCode || 503, err.code);
    }
    next(err);
  }
}
