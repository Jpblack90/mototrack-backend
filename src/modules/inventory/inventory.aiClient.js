import { GoogleGenAI } from '@google/genai';
import { PRODUCT_CATEGORIES } from './inventory.service.js';

// ─── Cliente Gemini ───────────────────────────────────────────────────────────

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Error controlado ─────────────────────────────────────────────────────────

class AppError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
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

// ─── Precalentamiento de conexión ─────────────────────────────────────────────

/**
 * Fuerza el handshake TLS/DNS con la API de Gemini durante el arranque del servidor.
 * Se llama en server.js sin await para no bloquear app.listen().
 *
 * Si falla (API key no configurada, sin red, etc.) solo loguea —
 * NUNCA debe tumbar el proceso de arranque.
 */
export async function warmUp() {
  try {
    await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      config: { thinkingConfig: { thinkingLevel: 'minimal' } },
    });
    console.log('🔥  Gemini warm-up completado.');
  } catch (err) {
    // Fallo silencioso — el servidor arranca igual
    console.warn(`⚠️   Gemini warm-up falló (${err.message ?? 'error desconocido'}). La primera llamada real puede ser más lenta.`);
  }
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Analiza la imagen de un repuesto de motocicleta con Gemini.
 *
 * ⚠️  PUNTO DE INTEGRACIÓN REAL — llama a la API de Google Gemini.
 *     Si la API no está disponible, lanza AppError AI_SERVICE_ERROR
 *     para que el usuario pueda registrar el producto manualmente (RF-02).
 *
 * @param {{ imageBase64: string, mimeType: string }} param
 * @returns {{ detected_name: string, detected_brand: string, confidence: number, latency_ms: number }}
 */
export async function analyzeProductImage({ imageBase64, mimeType }) {
  const start = Date.now();
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS) || 10000;
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new AppError('La IA tardó demasiado. Registra el producto manualmente.', 'AI_TIMEOUT', 503));
    }, timeoutMs);
  });

  try {
    const generatePromise = ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',   // ← cambiado desde 'gemini-3.6-flash' para cumplir RF-01 (<4s)
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
        // thinkingConfig con nivel mínimo (SDK v2.22.0):
        // "minimal" = mínimo razonamiento interno; suficiente para clasificación
        // de imagen simple. Los modelos 3.5+ usan thinkingLevel en lugar de
        // thinkingBudget (que está deprecated para esta familia de modelos).
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

    // El SDK garantiza JSON válido cuando se usa responseMimeType + responseSchema
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
    if (err.code === 'AI_TIMEOUT') {
      throw err;
    }
    // Cualquier fallo de la API (red, cuota, key inválida, timeout) se convierte
    // en un AppError controlado. El endpoint lo traduce a 503 y recomienda RF-02.
    throw new AppError(
      `El servicio de IA no está disponible en este momento (${err.message ?? 'error desconocido'}). ` +
      'Usa el registro manual (RF-02) para agregar el producto mientras se resuelve.',
      'AI_SERVICE_ERROR',
      503
    );
  } finally {
    clearTimeout(timer);
  }
}
