// =============================================================================
// scripts/tests/verify-12-1.js
// Suite de verificación integral de la Tarea 12.1:
// Plan único "MotoTrack", límites de escaneos IA y usuarios activos, y endpoint /company/plan.
// Solo utiliza empresas con prefijo "[PRUEBA]".
// =============================================================================

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/database.js';

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

async function request(reqPath, options = {}) {
  const url = `${API_BASE}${reqPath}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const fetchOptions = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, fetchOptions);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // respuesta sin JSON
  }

  return { status: res.status, ok: res.ok, data };
}

async function run() {
  console.log('\n===============================================================');
  console.log('🚀  VERIFICACIÓN INTEGRAL: TAREA 12.1 (PLANES Y LÍMITES)');
  console.log('===============================================================\n');

  let testCompanyId = null;
  let testUserId = null;
  let defaultPlanId = null;
  let customPlanId = null;
  const createdUserIds = [];

  try {
    // 0. Obtener plan oficial mototrack
    const { rows: mototrackRows } = await pool.query(
      `SELECT id, code, name, price_pen, max_users, max_ai_scans_month FROM plans WHERE code = 'mototrack' LIMIT 1`
    );
    if (!mototrackRows[0]) throw new Error("Plan oficial 'mototrack' no encontrado.");
    defaultPlanId = mototrackRows[0].id;

    assert(
      mototrackRows[0].code === 'mototrack' &&
      Number(mototrackRows[0].price_pen) === 99.00 &&
      mototrackRows[0].max_users === 10 &&
      mototrackRows[0].max_ai_scans_month === 1000,
      'Plan oficial "mototrack" configurado con 10 usuarios, 1000 escaneos y S/ 99.00'
    );

    // 1. Crear plan temporal de prueba con límites estrictos (max_users=2, max_ai_scans_month=1)
    const { rows: customPlanRows } = await pool.query(
      `INSERT INTO plans (code, name, price_pen, max_users, max_ai_scans_month, features)
       VALUES ('prueba-limites', 'Plan Prueba Límites', 49.00, 2, 1, '{"test": true}'::jsonb)
       ON CONFLICT (code) DO UPDATE
       SET max_users = 2, max_ai_scans_month = 1
       RETURNING id, code, name, max_users, max_ai_scans_month`
    );
    customPlanId = customPlanRows[0].id;

    // 2. Preparar empresa [PRUEBA] Taller B y asignarle el plan de prueba
    await pool.query(
      `UPDATE companies 
       SET is_active = true, plan_id = $1 
       WHERE razon_social LIKE '[PRUEBA] Taller B%'`,
      [customPlanId]
    );

    const { rows: compRows } = await pool.query(
      `SELECT id, razon_social FROM companies WHERE razon_social LIKE '[PRUEBA] Taller B%' LIMIT 1`
    );
    if (!compRows[0]) throw new Error('Empresa [PRUEBA] Taller B no encontrada.');
    testCompanyId = compRows[0].id;

    // Activar usuario admin de Empresa B
    await pool.query(
      `UPDATE users SET is_active = true, role = 'admin' WHERE email = 'pruebab@mototrack.local'`
    );
    const { rows: uRows } = await pool.query(
      `SELECT id, email, role, company_id FROM users WHERE email = 'pruebab@mototrack.local' LIMIT 1`
    );
    testUserId = uRows[0].id;

    // Limpiar usuarios secundarios de pruebas previas de este script
    await pool.query(
      `DELETE FROM users WHERE company_id = $1 AND email LIKE 'limit_test_%' AND company_id IN (SELECT id FROM companies WHERE razon_social LIKE '[PRUEBA]%')`,
      [testCompanyId]
    );

    // Desactivar otros usuarios de Empresa B para empezar con exactamente 1 usuario activo (su admin)
    await pool.query(
      `UPDATE users SET is_active = false WHERE company_id = $1 AND id != $2`,
      [testCompanyId, testUserId]
    );

    // Limpiar escaneos previos de Empresa B
    await pool.query(`DELETE FROM ai_usage WHERE company_id = $1`, [testCompanyId]);

    // Token de autenticación para Empresa B
    const tokenB = jwt.sign(
      {
        id: testUserId,
        email: uRows[0].email,
        role: uRows[0].role,
        company_id: testCompanyId,
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 1: Escaneos fallidos NO consumen cupo
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 1: Escaneos fallidos no consumen cupo ---');
    await pool.query(
      `INSERT INTO ai_usage (company_id, user_id, model, input_tokens, output_tokens, thinking_tokens, latency_ms, success, error_code, estimated_cost_usd)
       VALUES ($1, $2, 'gemini-3.5-flash-lite', 0, 0, 0, 1000, false, 'AI_TIMEOUT', 0)`,
      [testCompanyId, testUserId]
    );

    const rPlanUsage1 = await request('/company/plan', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(
      rPlanUsage1.status === 200 && rPlanUsage1.data?.data?.ai_scans_this_month === 0,
      'Los escaneos fallidos (success = false) no consumen cupo en ai_scans_this_month (conteo = 0)'
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 2: Primer escaneo IA exitoso (alcanza el límite de 1)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 2: Primer escaneo IA exitoso (dentro del límite) ---');
    const photoPath = path.resolve('../mototrack-frontend/docs/pruebas-ia/Foto2.jpg');
    const photoBase64 = fs.readFileSync(photoPath).toString('base64');

    let rScan1 = await request('/inventory/scan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { image_base64: photoBase64, mime_type: 'image/jpeg' },
    });
    if (rScan1.status !== 200) {
      console.log('   (Reintentando escaneo inicial por fluctuación de latencia...)');
      await new Promise((r) => setTimeout(r, 2000));
      rScan1 = await request('/inventory/scan', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenB}` },
        body: { image_base64: photoBase64, mime_type: 'image/jpeg' },
      });
    }
    assert(
      rScan1.status === 200 && rScan1.data?.success === true,
      `Primer escaneo responde 200 OK (consumo 1 de 1)`
    );

    const rPlanUsage2 = await request('/company/plan', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(
      rPlanUsage2.data?.data?.ai_scans_this_month === 1,
      'ai_scans_this_month se incrementa exactamente a 1 tras el escaneo exitoso'
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 3: Segundo escaneo bloqueado por límite de plan (403 PLAN_LIMIT_REACHED)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 3: Segundo escaneo bloqueado con 403 PLAN_LIMIT_REACHED ---');
    const { rows: scansBefore } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ai_usage WHERE company_id = $1`,
      [testCompanyId]
    );

    const rScan2 = await request('/inventory/scan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { image_base64: photoBase64, mime_type: 'image/jpeg' },
    });

    assert(
      rScan2.status === 403 &&
      rScan2.data?.error?.code === 'PLAN_LIMIT_REACHED' &&
      rScan2.data?.error?.message?.includes('Alcanzaste los 1 escaneos con IA de este mes'),
      'Segundo escaneo bloqueado con 403 y code="PLAN_LIMIT_REACHED"',
      `status: ${rScan2.status}, code: ${rScan2.data?.error?.code}, message: "${rScan2.data?.error?.message}"`
    );

    // Verificar que NO se llamó a Gemini y NO se insertó fila en ai_usage
    const { rows: scansAfter } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ai_usage WHERE company_id = $1`,
      [testCompanyId]
    );
    assert(
      scansBefore[0].count === scansAfter[0].count,
      'La comprobación ocurrió ANTES de Gemini: cero filas agregadas a ai_usage tras el rechazo 403'
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 4: Control de límite de usuarios activos (max_users = 2)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 4: Control de límite de usuarios activos (max_users = 2) ---');

    // Empresa B tiene 1 usuario activo (admin). Crear segundo usuario -> debe permitirlo (201)
    const emailUser2 = `limit_test_2_${Date.now()}@mototrack.local`;
    const rCreateUser2 = await request('/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        name: 'Segundo Usuario Test',
        email: emailUser2,
        password: 'Password123!',
        role: 'cajero',
      },
    });

    assert(
      rCreateUser2.status === 201,
      'Crear segundo usuario responde 201 Created (total activos = 2 de 2)'
    );
    if (rCreateUser2.data?.data?.id) createdUserIds.push(rCreateUser2.data.data.id);

    // Intentar crear tercer usuario -> debe rechazar con 403 PLAN_LIMIT_REACHED
    const emailUser3 = `limit_test_3_${Date.now()}@mototrack.local`;
    const rCreateUser3 = await request('/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        name: 'Tercer Usuario Test',
        email: emailUser3,
        password: 'Password123!',
        role: 'mecanico',
      },
    });

    assert(
      rCreateUser3.status === 403 &&
      rCreateUser3.data?.error?.code === 'PLAN_LIMIT_REACHED' &&
      rCreateUser3.data?.error?.message?.includes('Tu plan permite hasta 2 usuarios activos'),
      'Crear tercer usuario supera max_users=2 y responde 403 PLAN_LIMIT_REACHED',
      `status: ${rCreateUser3.status}, code: ${rCreateUser3.data?.error?.code}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 5: Consulta de plan vía GET /api/company/plan (Privacidad y Métricas)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 5: Consulta de plan vía GET /api/company/plan ---');
    const rPlanFinal = await request('/company/plan', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    const planData = rPlanFinal.data?.data;
    assert(
      rPlanFinal.status === 200 &&
      planData?.plan?.name === 'Plan Prueba Límites' &&
      planData?.plan?.max_users === 2 &&
      planData?.plan?.max_ai_scans_month === 1 &&
      planData?.users_active === 2 &&
      planData?.ai_scans_this_month === 1,
      'GET /api/company/plan refleja exactamente las métricas de consumo y límites'
    );

    // Privacidad: NO debe exponer costos ni tokens
    const exposedSecrets =
      planData?.tokens !== undefined ||
      planData?.input_tokens !== undefined ||
      planData?.cost !== undefined ||
      planData?.estimated_cost_usd !== undefined;

    assert(
      !exposedSecrets,
      'GET /api/company/plan protege la privacidad: NUNCA expone costos en dólares ni tokens'
    );

  } catch (err) {
    console.error('💥  Error inesperado durante la verificación:', err);
    failedTests++;
  } finally {
    // Limpieza de datos [PRUEBA]
    console.log('\n🧹  Limpieza: Restaurando plan oficial mototrack y desactivando datos [PRUEBA]...');
    if (testCompanyId && defaultPlanId) {
      await pool.query(
        `UPDATE companies SET plan_id = $1, is_active = false WHERE id = $2`,
        [defaultPlanId, testCompanyId]
      );
    }
    if (createdUserIds.length > 0) {
      await pool.query(
        `DELETE FROM users WHERE id = ANY($1::int[]) AND company_id IN (SELECT id FROM companies WHERE razon_social LIKE '[PRUEBA]%')`,
        [createdUserIds]
      );
    }
    await pool.query(
      `UPDATE users SET is_active = false WHERE company_id = $1 AND company_id IN (SELECT id FROM companies WHERE razon_social LIKE '[PRUEBA]%')`,
      [testCompanyId]
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
    console.log('🎉  TODAS LAS PRUEBAS DE LA TAREA 12.1 PASARON EXITOSAMENTE.');
    console.log('===============================================================\n');
    process.exitCode = 0;
  }
}

run();
