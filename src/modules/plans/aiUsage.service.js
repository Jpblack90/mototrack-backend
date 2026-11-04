import pool from '../../config/database.js';

/**
 * Registra un intento de uso de la IA (exitoso o fallido) en la tabla ai_usage.
 *
 * @param {object} params
 * @param {number} params.companyId ID de la empresa
 * @param {number|null} [params.userId] ID del usuario autenticado
 * @param {string} params.model Modelo de Gemini utilizado
 * @param {number} [params.inputTokens] Tokens de entrada (prompt)
 * @param {number} [params.outputTokens] Tokens de salida (candidatos)
 * @param {number} [params.thinkingTokens] Tokens de razonamiento
 * @param {number} [params.latencyMs] Latencia de respuesta en milisegundos
 * @param {boolean} params.success Si la llamada fue exitosa
 * @param {string|null} [params.errorCode] Código de error si falló
 * @returns {Promise<object|null>} Registro insertado o null si ocurre error
 */
export async function recordUsage({
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
  if (!companyId) return null;

  try {
    const priceInputPerM = Number(process.env.AI_PRICE_INPUT_PER_M) || 0.30;
    const priceOutputPerM = Number(process.env.AI_PRICE_OUTPUT_PER_M) || 2.50;

    const costInput = (inputTokens / 1_000_000) * priceInputPerM;
    const totalOutputTokens = outputTokens + thinkingTokens;
    const costOutput = (totalOutputTokens / 1_000_000) * priceOutputPerM;
    const estimatedCostUsd = Number((costInput + costOutput).toFixed(6));

    const { rows } = await pool.query(
      `INSERT INTO ai_usage (
        company_id, user_id, model, input_tokens, output_tokens,
        thinking_tokens, latency_ms, success, error_code, estimated_cost_usd
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
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

    return rows[0];
  } catch (err) {
    // Si falla el INSERT, no bloquea el flujo principal
    console.error('❌ [IA] Error al registrar métricas en ai_usage:', err.message);
    return null;
  }
}

/**
 * Cuenta los escaneos exitosos (success = true) de una empresa en el periodo dado.
 *
 * @param {number} companyId ID de la empresa
 * @param {string} from Fecha/hora de inicio en ISO con zona horaria
 * @param {string} to Fecha/hora de fin en ISO con zona horaria
 * @returns {Promise<number>} Cantidad de escaneos exitosos
 */
export async function countMonthlySuccessfulScans(companyId, from, to) {
  if (!companyId) return 0;

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count 
     FROM ai_usage 
     WHERE company_id = $1 
       AND success = true 
       AND created_at >= $2::timestamptz 
       AND created_at < $3::timestamptz`,
    [companyId, from, to]
  );

  return rows[0]?.count ?? 0;
}
