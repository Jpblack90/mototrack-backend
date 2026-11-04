import { GoogleGenAI } from '@google/genai';
import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';
import { PRODUCT_CATEGORIES } from './inventory.service.js';

// ─── Cliente Gemini ───────────────────────────────────────────────────────────

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Estado de Diagnóstico de la IA ───────────────────────────────────────────

let aiHealthStatus = 'unknown'; // 'ok' | 'invalid_key' | 'unconfigured' | 'unknown'

/**
 * Devuelve el estado de diagnóstico actual del servicio de IA
 * @returns {'ok' | 'invalid_key' | 'unconfigured' | 'unknown'}
 */
export function getAiHealthStatus() {
  return aiHealthStatus;
}

// ─── Mapeo Puro de Errores de Gemini (Tarea 12.0) ──────────────────────────────

/**
 * Función pura que categoriza cualquier error de Google Gemini o red
 * y devuelve un código, status HTTP y mensaje amigable para el usuario sin datos técnicos.
 *
 * @param {Error|any} err Objeto de error capturado
 * @returns {{ code: string, status: number, userMessage: string }}
 */
export function mapGeminiError(err) {
  if (!err) {
    return {
      code: 'AI_SERVICE_ERROR',
      status: 503,
      userMessage: 'El servicio de IA no está disponible en este momento. Registra el producto manualmente.',
    };
  }

  const status = Number(err.status || err.statusCode || (typeof err.code === 'number' ? err.code : 0));
  const codeStr = String(err.code || '');
  const messageStr = String(err.message || '');
  const errBodyStr = typeof err.errorDetails === 'string'
    ? err.errorDetails
    : (err.errorDetails ? JSON.stringify(err.errorDetails) : '');
  const combined = `${codeStr} ${messageStr} ${errBodyStr}`.toLowerCase();

  // 1. Timeout
  if (
    codeStr === 'AI_TIMEOUT' ||
    err.name === 'TimeoutError' ||
    combined.includes('ai_timeout') ||
    combined.includes('demasiado') ||
    combined.includes('timed out')
  ) {
    return {
      code: 'AI_TIMEOUT',
      status: 503,
      userMessage: 'La IA tardó demasiado. Registra el producto manualmente.',
    };
  }

  // 2. Clave inválida o vencida (401/403 de Google, API_KEY_INVALID, UNAUTHENTICATED)
  if (
    status === 401 ||
    status === 403 ||
    codeStr === 'API_KEY_INVALID' ||
    codeStr === 'UNAUTHENTICATED' ||
    combined.includes('api_key_invalid') ||
    combined.includes('unauthenticated') ||
    combined.includes('api key not valid') ||
    combined.includes('key expired') ||
    combined.includes('permission_denied')
  ) {
    return {
      code: 'AI_NOT_CONFIGURED',
      status: 503,
      userMessage: 'El escaneo con IA no está disponible por el momento. Registra el producto manualmente.',
    };
  }

  // 3. Cuota de Google agotada (429, RESOURCE_EXHAUSTED)
  if (
    status === 429 ||
    codeStr === 'RESOURCE_EXHAUSTED' ||
    codeStr === '429' ||
    combined.includes('resource_exhausted') ||
    combined.includes('quota exceeded') ||
    combined.includes('rate limit') ||
    combined.includes('exhausted')
  ) {
    return {
      code: 'AI_QUOTA',
      status: 503,
      userMessage: 'La IA está saturada en este momento. Intenta en unos minutos o registra el producto manualmente.',
    };
  }

  // 4. Cualquier otro fallo
  return {
    code: 'AI_SERVICE_ERROR',
    status: 503,
    userMessage: 'El servicio de IA no está disponible en este momento. Registra el producto manualmente.',
  };
}

// ─── Prompt de análisis ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un experto en identificación de repuestos y accesorios para motocicletas en Perú.
Se te mostrará la imagen de un empaque o de un repuesto. Tu tarea es:
1. Identificar el nombre comercial más probable del producto (detected_name).
2. Identificar la marca del fabricante (detected_brand).
3. Clasificar el producto en una de las siguientes categorías válidas (detected_category):
   ['Motor', 'Filtros', 'Frenos', 'Transmisión', 'Suspensión', 'Sistema eléctrico', 'Iluminación', 'Llantas y cámaras', 'Lubricantes', 'Carrocería', 'Accesorios', 'Otros'].
4. Estimar tu nivel de confianza (0-100) sobre la identificación (confidence), donde:
   - 80-100: nombre y marca claramente visibles en el empaque.
   - 50-79: texto parcial o logo visible, identificación probable pero con dudas.
   - 0-49: imagen borrosa, empaque genérico o repuesto sin identificación clara.
5. Identificar o sugerir modelos de motocicleta compatibles (suggested_compatible_models) e indicar la fuente (compatibility_source):
   - Si en la imagen hay texto visible de modelos de moto compatibles (en el empaque, etiqueta o rótulo), cópialos tal cual en el array y usa compatibility_source = 'empaque'.
   - Si no hay texto de modelos pero la pieza es reconocible con certeza, sugiere únicamente modelos comercializados en Perú (marcas como Honda, Bajaj, Yamaha, Suzuki, TVS, Ronco, Wanxin, etc., formato "Marca Modelo", ej. "Honda CG125", "Bajaj Pulsar NS200", "Yamaha FZ16"), máximo 8 modelos, y usa compatibility_source = 'inferido'. No sugieras marcas que no se venden en Perú.
   - Si no puedes saberlo con certeza, devuelve un array vacío [] y compatibility_source = 'ninguno'.
   - Está ESTRICTAMENTE PROHIBIDO inventar o alucinar modelos para rellenar el campo.

REGLA DE IDIOMA OBLIGATORIA:
Todos los textos (detected_name, detected_category) deben estar en ESPAÑOL, sin importar el idioma del texto en el empaque.
Si dice "Oil Filter", escribe "Filtro de Aceite". Si dice "Brake Pads", escribe "Pastillas de Freno".

Responde ÚNICAMENTE con el objeto JSON requerido por el schema, sin texto adicional.`;

// ─── Precalentamiento de conexión (warm-up) ───────────────────────────────────

/**
 * Fuerza el handshake TLS/DNS y valida la credencial de Gemini durante el arranque del servidor.
 */
export async function warmUp() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    aiHealthStatus = 'unconfigured';
    console.error('❌ [IA] GEMINI_API_KEY no está configurada: el escaneo con IA no funcionará.');
    return;
  }

  try {
    await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      config: { thinkingConfig: { thinkingLevel: 'minimal' } },
    });
    aiHealthStatus = 'ok';
    console.log('🔥 Gemini warm-up completado');
  } catch (err) {
    const mapped = mapGeminiError(err);
    if (mapped.code === 'AI_NOT_CONFIGURED') {
      aiHealthStatus = 'invalid_key';
      console.error('❌ [IA] GEMINI_API_KEY inválida o vencida');
    } else {
      aiHealthStatus = 'unknown';
      console.error(`❌ [IA] Gemini warm-up falló: ${err.message ?? 'error desconocido'}`);
    }
  }
}

// ─── Registro de consumo de IA ────────────────────────────────────────────────

async function recordAiUsage({
  companyId,
  userId,
  model,
  inputTokens = 0,
  outputTokens = 0,
  thinkingTokens = 0,
  latencyMs = 0,
  success,
  errorCode = null,
}) {
  if (!companyId) return;

  try {
    const priceInputPerM = Number(process.env.AI_PRICE_INPUT_PER_M) || 0.30;
    const priceOutputPerM = Number(process.env.AI_PRICE_OUTPUT_PER_M) || 2.50;

    const costInput = (inputTokens / 1_000_000) * priceInputPerM;
    const totalOutputTokens = outputTokens + thinkingTokens;
    const costOutput = (totalOutputTokens / 1_000_000) * priceOutputPerM;
    const estimatedCostUsd = Number((costInput + costOutput).toFixed(6));

    await pool.query(
      `INSERT INTO ai_usage (
        company_id, user_id, model, input_tokens, output_tokens,
        thinking_tokens, latency_ms, success, error_code, estimated_cost_usd
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        companyId,
        userId ?? null,
        model,
        inputTokens,
        outputTokens,
        thinkingTokens,
        latencyMs,
        success,
        errorCode,
        estimatedCostUsd,
      ]
    );
  } catch (err) {
    // Si falla el INSERT, solo se loguea pero NO rompe la respuesta
    console.error('❌ [IA] Error al registrar métricas en ai_usage:', err.message);
  }
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Analiza la imagen de un repuesto de motocicleta con Gemini y registra consumo por empresa.
 *
 * @param {{ imageBase64: string, mimeType: string, companyId?: number, userId?: number }} param
 * @returns {Promise<{ detected_name: string, detected_brand: string, confidence: number, latency_ms: number }>}
 */
export async function analyzeProductImage({ imageBase64, mimeType, companyId, userId }) {
  const start = Date.now();
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS) || 15000;
  const model = 'gemini-3.5-flash-lite';
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new AppError('La IA tardó demasiado. Registra el producto manualmente.', 'AI_TIMEOUT', 503));
    }, timeoutMs);
  });

  try {
    const generatePromise = ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: SYSTEM_PROMPT },
            {
              inlineData: {
                mimeType,
                data: imageBase64,
              },
            },
          ],
        },
      ],
      config: {
        thinkingConfig: {
          thinkingLevel: 'minimal',
        },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            detected_name:  { type: 'string'  },
            detected_brand: { type: 'string'  },
            confidence:     { type: 'number'  },
            detected_category: {
              type: 'string',
              enum: PRODUCT_CATEGORIES,
            },
            suggested_compatible_models: {
              type: 'array',
              items: { type: 'string' },
            },
            compatibility_source: {
              type: 'string',
              enum: ['empaque', 'inferido', 'ninguno'],
            },
          },
          required: [
            'detected_name',
            'detected_brand',
            'confidence',
            'detected_category',
            'suggested_compatible_models',
            'compatibility_source',
          ],
        },
      },
    });

    const response = await Promise.race([generatePromise, timeoutPromise]);
    const latency_ms = Date.now() - start;

    const input_tokens = response.usageMetadata?.promptTokenCount ?? 0;
    const output_tokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    const thinking_tokens = response.usageMetadata?.thoughtsTokenCount ?? 0;

    // Registro no bloqueante de consumo exitoso
    await recordAiUsage({
      companyId,
      userId,
      model,
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      thinkingTokens: thinking_tokens,
      latencyMs: latency_ms,
      success: true,
      errorCode: null,
    });

    const parsed = JSON.parse(response.text);

    return {
      detected_name:               parsed.detected_name  ?? '',
      detected_brand:              parsed.detected_brand ?? '',
      confidence:                  Number(parsed.confidence ?? 0),
      detected_category:           parsed.detected_category ?? 'Otros',
      suggested_compatible_models: Array.isArray(parsed.suggested_compatible_models)
        ? parsed.suggested_compatible_models.slice(0, 8)
        : [],
      compatibility_source:        parsed.compatibility_source ?? 'ninguno',
      latency_ms,
    };

  } catch (err) {
    const latency_ms = Date.now() - start;
    const mapped = mapGeminiError(err);

    // El detalle técnico de Google SOLO se imprime en la consola del servidor con prefijo [IA]
    console.error('[IA] Detalle técnico de Google Gemini:', {
      status: err.status || err.statusCode,
      message: err.message,
      code: err.code,
      errorDetails: err.errorDetails,
    });

    // Registro no bloqueante del intento fallido
    await recordAiUsage({
      companyId,
      userId,
      model,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      latencyMs: latency_ms,
      success: false,
      errorCode: mapped.code,
    });

    throw new AppError(mapped.userMessage, mapped.code, mapped.status);
  } finally {
    clearTimeout(timer);
  }
}
