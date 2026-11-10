// =============================================================================
// scripts/tests/verify-12-0.js
// Suite de verificación de la Tarea 12.0:
// Errores de la IA, sanitización de mensajes y medición de consumo por taller.
// =============================================================================

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/database.js';
import { mapGeminiError } from '../../src/modules/inventory/inventory.aiClient.js';

const API_BASE = process.env.API_URL || 'http://localhost:4000/api';
const JWT_SECRET = process.env.JWT_SECRET || 'MySecretK3yForJWTs1234567890!@#%^&*()_+|';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message, details = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASA] ${message}`);
  } else {
    failedTests++;
    console.error(`  [FALLA] ${message} ${details ? `(${details})` : ''}`);
  }
}

async function run() {
  console.log('\n===============================================================');
  console.log('🚀  VERIFICACIÓN INTEGRAL: TAREA 12.0 (ERRORES Y CONSUMO IA)');
  console.log('===============================================================\n');

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Parte 1: Pruebas unitarias de mapGeminiError y sanitización
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Parte 1: Pruebas unitarias de mapGeminiError ---');

    // 1a. Clave inválida (400 con API_KEY_INVALID de Google)
    const errInvalidKey = {
      status: 400,
      message: 'API key not valid. Please pass a valid API key. [400 Bad Request] https://generativelanguage.googleapis.com/...',
      errorDetails: [{ reason: 'API_KEY_INVALID' }],
    };
    const mappedInvalid = mapGeminiError(errInvalidKey);
    assert(
      mappedInvalid.code === 'AI_NOT_CONFIGURED' && mappedInvalid.status === 503,
      'Error de clave inválida (API_KEY_INVALID) mapea a AI_NOT_CONFIGURED y 503',
      `code: ${mappedInvalid.code}, status: ${mappedInvalid.status}`
    );

    // 1b. Clave vencida / no autenticada (401/403 UNAUTHENTICATED)
    const errUnauth = {
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'Request is missing required authentication credential.',
    };
    const mappedUnauth = mapGeminiError(errUnauth);
    assert(
      mappedUnauth.code === 'AI_NOT_CONFIGURED' && mappedUnauth.status === 503,
      'Error de autenticación (UNAUTHENTICATED / 401) mapea a AI_NOT_CONFIGURED y 503',
      `code: ${mappedUnauth.code}`
    );

    // 1c. Cuota de Google agotada (429 / RESOURCE_EXHAUSTED)
    const errQuota = {
      status: 429,
      code: 'RESOURCE_EXHAUSTED',
      message: 'Resource has been exhausted (e.g. check quota). [429 Too Many Requests]',
    };
    const mappedQuota = mapGeminiError(errQuota);
    assert(
      mappedQuota.code === 'AI_QUOTA' && mappedQuota.status === 503,
      'Error de cuota agotada (429 RESOURCE_EXHAUSTED) mapea a AI_QUOTA y 503',
      `code: ${mappedQuota.code}`
    );

    // 1d. Timeout
    const errTimeout = {
      code: 'AI_TIMEOUT',
      message: 'La IA tardó demasiado. Registra el producto manualmente.',
    };
    const mappedTimeout = mapGeminiError(errTimeout);
    assert(
      mappedTimeout.code === 'AI_TIMEOUT' && mappedTimeout.status === 503,
      'Error de timeout mapea a AI_TIMEOUT y 503',
      `code: ${mappedTimeout.code}`
    );

    // 1e. Otro error genérico
    const errOther = new Error('FetchError: request to https://generativelanguage.googleapis.com failed, reason: socket hang up');
    const mappedOther = mapGeminiError(errOther);
    assert(
      mappedOther.code === 'AI_SERVICE_ERROR' && mappedOther.status === 503,
      'Error de red o desconocido mapea a AI_SERVICE_ERROR y 503',
      `code: ${mappedOther.code}`
    );

    // 1f. Sanitización estricta de userMessage para todos los casos
    const allMapped = [mappedInvalid, mappedUnauth, mappedQuota, mappedTimeout, mappedOther];
    let allSanitized = true;
    for (const m of allMapped) {
      const msg = m.userMessage;
      if (
        msg.includes('googleapis') ||
        msg.includes('UNAUTHENTICATED') ||
        msg.includes('{') ||
        msg.includes('}')
      ) {
        allSanitized = false;
        console.error('Mensaje no sanitizado detectado:', msg);
        break;
      }
    }
    assert(
      allSanitized,
      'userMessage sanitizado: no contiene "googleapis", "UNAUTHENTICATED" ni caracteres JSON ("{")'
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Parte 2: Escaneo real con foto y medición en ai_usage
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Parte 2: Escaneo real con foto desde empresa [PRUEBA] ---');

    // Buscar o preparar empresa de prueba
    await pool.query(
      `UPDATE companies SET is_active = true WHERE razon_social LIKE '[PRUEBA] Taller B%'`
    );
    const { rows: compRows } = await pool.query(
      `SELECT id, razon_social FROM companies WHERE razon_social LIKE '[PRUEBA] Taller B%' LIMIT 1`
    );
    if (!compRows[0]) throw new Error('Empresa [PRUEBA] Taller B no encontrada.');
    const testCompanyId = compRows[0].id;

    // Buscar usuario admin de la empresa de prueba
    await pool.query(
      `UPDATE users SET is_active = true WHERE email = 'pruebab@mototrack.local'`
    );
    const { rows: userRows } = await pool.query(
      `SELECT id, email, role, company_id FROM users WHERE email = 'pruebab@mototrack.local' LIMIT 1`
    );
    if (!userRows[0]) throw new Error('Usuario pruebab@mototrack.local no encontrado.');
    const testUser = userRows[0];

    // Generar token JWT válido para la prueba
    const testToken = jwt.sign(
      {
        id: testUser.id,
        email: testUser.email,
        role: testUser.role,
        company_id: testCompanyId,
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Cargar imagen de prueba desde mototrack-frontend/docs/pruebas-ia/
    const photoPath = path.resolve('../mototrack-frontend/docs/pruebas-ia/Foto2.jpg');
    if (!fs.existsSync(photoPath)) {
      throw new Error(`No se encontró la foto de prueba en: ${photoPath}`);
    }
    const photoBuffer = fs.readFileSync(photoPath);
    const photoBase64 = photoBuffer.toString('base64');

    console.log(`  📸 Enviando escaneo real de repuesto (${photoBuffer.length} bytes)...`);
    const scanStart = Date.now();
    let resScan = null;
    let scanData = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      resScan = await fetch(`${API_BASE}/inventory/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${testToken}`,
        },
        body: JSON.stringify({
          image_base64: photoBase64,
          mime_type: 'image/jpeg',
        }),
      });
      scanData = await resScan.json().catch(() => ({}));
      if (resScan.status === 200) break;
      if (attempt < 3) {
        console.log(`   (Reintento ${attempt}/3 escaneo real por fluctuación de latencia/red...)`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    const scanLatency = Date.now() - scanStart;

    assert(
      resScan.status === 200 && scanData.success === true,
      `Escaneo real responde 200 OK en ${scanLatency}ms (detected: "${scanData.data?.detected_name}")`,
      `status: ${resScan.status}, error: ${JSON.stringify(scanData.error)}`
    );

    // Verificar que se insertó la fila en ai_usage
    const { rows: usageRows } = await pool.query(
      `SELECT id, company_id, user_id, model, input_tokens, output_tokens, thinking_tokens, latency_ms, success, estimated_cost_usd
       FROM ai_usage
       WHERE company_id = $1
       ORDER BY id DESC LIMIT 1`,
      [testCompanyId]
    );

    assert(usageRows.length > 0, 'Se insertó el registro de métricas en la tabla ai_usage');

    const lastUsage = usageRows[0];
    assert(
      lastUsage.company_id === testCompanyId && lastUsage.user_id === testUser.id,
      `ai_usage vincula correctamente company_id=${testCompanyId} y user_id=${testUser.id}`
    );
    assert(
      lastUsage.success === true,
      'ai_usage registra success = true para el escaneo exitoso'
    );
    assert(
      lastUsage.input_tokens > 0 && lastUsage.output_tokens > 0,
      `ai_usage registra tokens reales (input: ${lastUsage.input_tokens}, output: ${lastUsage.output_tokens}, thinking: ${lastUsage.thinking_tokens ?? 0})`
    );
    assert(
      Number(lastUsage.estimated_cost_usd) > 0,
      `ai_usage calcula el costo estimado financiero ($${Number(lastUsage.estimated_cost_usd).toFixed(6)} USD)`
    );

  } catch (err) {
    console.error('💥  Error inesperado durante la verificación:', err);
    failedTests++;
  } finally {
    // Limpieza de empresas [PRUEBA]
    await pool.query(
      `UPDATE companies SET is_active = false WHERE razon_social LIKE '[PRUEBA]%'`
    );
    await pool.query(
      `UPDATE users SET is_active = false WHERE email = 'pruebab@mototrack.local'`
    );
    await pool.end();
  }

  console.log('\n===============================================================');
  console.log(`📊  RESULTADOS: ${passedTests}/${totalTests} pruebas pasaron.`);
  if (failedTests > 0) {
    console.log(`❌  ${failedTests} prueba(s) fallaron.`);
    console.log('===============================================================\n');
    process.exitCode = 1;
  } else {
    console.log('🎉  TODAS LAS PRUEBAS DE LA TAREA 12.0 PASARON EXITOSAMENTE.');
    console.log('===============================================================\n');
    process.exitCode = 0;
  }
}

run();
