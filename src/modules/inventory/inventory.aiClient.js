import { GoogleGenAI } from '@google/genai';

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

const SYSTEM_PROMPT = `Eres un experto en identificación de repuestos y accesorios para motocicletas.
Se te mostrará la imagen de un empaque o de un repuesto. Tu tarea es:
1. Identificar el nombre comercial más probable del producto.
2. Identificar la marca del fabricante.
3. Estimar tu nivel de confianza (0-100) sobre la identificación, donde:
   - 80-100: nombre y marca claramente visibles en el empaque.
   - 50-79: texto parcial o logo visible, identificación probable pero con dudas.
   - 0-49: imagen borrosa, empaque genérico o repuesto sin identificación clara.

Responde ÚNICAMENTE con el objeto JSON requerido, sin texto adicional.`;

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

  try {
    const response = await ai.models.generateContent({
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
          },
          required: ['detected_name', 'detected_brand', 'confidence'],
        },
      },
    });

    const latency_ms = Date.now() - start;

    // El SDK garantiza JSON válido cuando se usa responseMimeType + responseSchema
    const parsed = JSON.parse(response.text);

    return {
      detected_name:  parsed.detected_name  ?? '',
      detected_brand: parsed.detected_brand ?? '',
      confidence:     Number(parsed.confidence ?? 0),
      latency_ms,
    };

  } catch (err) {
    // Cualquier fallo de la API (red, cuota, key inválida, timeout) se convierte
    // en un AppError controlado. El endpoint lo traduce a 503 y recomienda RF-02.
    throw new AppError(
      `El servicio de IA no está disponible en este momento (${err.message ?? 'error desconocido'}). ` +
      'Usa el registro manual (RF-02) para agregar el producto mientras se resuelve.',
      'AI_SERVICE_ERROR',
      503
    );
  }
}
