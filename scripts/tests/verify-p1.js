// =============================================================================
// scripts/tests/verify-p1.js
// Suite de verificación Tarea P1: Panel de plataforma (super-admin) backend
//
// Cobertura:
// - Auth separada (/api/platform/auth/login, JWT con scope 'platform', 8h, 401 genérico)
// - Política de contraseñas + bloqueo 403 PASSWORD_CHANGE_REQUIRED mientras must_change_password = true
// - Aislamiento estricto: token taller -> 401 en /api/platform/*; token plataforma -> 401 en /api/inventory y /api/users
// - Métricas globales y listado /api/platform/companies (búsqueda unaccent, filtro estado, conteos)
// - Detalle /api/platform/companies/:id sin ninguna clave ni dato de negocio
// - Reset password usuario de taller + auditoría dual (platform_audit_logs + audit_logs entity='platform_support')
// - Suspender / reactivar taller (reason 10-300 chars, short reason -> 422, login taller -> 403 -> 200)
// - Registro de pago vía recordPayment de subscription.service.js + auditoría dual
// - Inmutabilidad de platform_audit_logs (UPDATE y DELETE bloqueados por trigger)
// - Script CLI scripts/create-platform-admin.js
// - PLATFORM_JWT_SECRET ausente -> HTTP 503 en /api/platform/* sin afectar el resto del sistema
// =============================================================================

import 'dotenv/config';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import app from '../../src/app.js';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const API_URL = process.env.API_URL || `http://localhost:${process.env.PORT ?? 4000}/api`;
const PLATFORM_SUPPORT_EMAIL = 'prueba.soporte@mototrack.local';
const PLATFORM_SUPPORT_NAME = '[PRUEBA] Soporte';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message, details = null) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASA] ${message}`);
  } else {
    failedTests++;
    console.error(`  [FALLA] ${message}`);
    if (details) {
      console.error('    Detalle:', JSON.stringify(details));
    }
  }
}

async function request(endpoint, options = {}, baseUrl = API_URL) {
  const url = `${baseUrl}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const config = {
    method: options.method || 'GET',
    headers,
  };
  if (options.body !== undefined) {
    config.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, config);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Respuesta no JSON
  }
  return { status: res.status, data };
}

function collectObjectKeys(value, acc = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjectKeys(item, acc);
    }
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      collectObjectKeys(v, acc);
    }
  }
  return acc;
}

function makeTempSecretPassword() {
  return `Pr${crypto.randomBytes(6).toString('hex')}9`;
}

async function resetRateLimit() {
  try {
    await fetch(`${API_URL}/auth/reset-rate-limit`, { method: 'POST' });
  } catch {
    // Ignorar si hooks están desactivados
  }
}

async function run() {
  console.log('\n===============================================================');
  console.log('🧪  INICIANDO SUITE VERIFY-P1: PANEL DE PLATAFORMA (SUPER-ADMIN)');
  console.log('===============================================================\n');

  let companyA = null;
  let companyB = null;
  let platformAdminId = null;
  let disposableCliEmail = null;

  const initialPlatformPwd = makeTempSecretPassword();
  const rotatedPlatformPwd = makeTempSecretPassword();

  try {
    await resetRateLimit();

    // 1. Preparar talleres de prueba [PRUEBA] y plataforma admin [PRUEBA]
    const seed = await seedTestCompany();
    companyA = seed.companyA;
    companyB = seed.companyB;

    await pool.query(
      `UPDATE companies SET is_active = true, status = 'active', paid_until = NULL WHERE id IN ($1, $2)`,
      [companyA.companyId, companyB.companyId]
    );
    await pool.query(
      `UPDATE users SET is_active = true WHERE company_id IN ($1, $2)`,
      [companyA.companyId, companyB.companyId]
    );

    const initialHash = await bcrypt.hash(initialPlatformPwd, 10);
    const { rows: paRows } = await pool.query(
      `INSERT INTO platform_admins (name, email, password_hash, is_active, must_change_password)
       VALUES ($1, $2, $3, true, true)
       ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name,
           password_hash = EXCLUDED.password_hash,
           is_active = true,
           must_change_password = true,
           updated_at = NOW()
       RETURNING id`,
      [PLATFORM_SUPPORT_NAME, PLATFORM_SUPPORT_EMAIL, initialHash]
    );
    platformAdminId = paRows[0].id;

    // 2. Autenticación de plataforma y must_change_password
    console.log('--- 1. Autenticación de plataforma y cambio de contraseña obligatorio ---');

    const badLogin = await request('/platform/auth/login', {
      method: 'POST',
      body: { email: PLATFORM_SUPPORT_EMAIL, password: 'WrongPassword99!' },
    });
    assert(
      badLogin.status === 401 && badLogin.data?.error?.code === 'INVALID_CREDENTIALS',
      'Login plataforma con contraseña incorrecta responde 401 genérico',
      badLogin
    );

    const firstLogin = await request('/platform/auth/login', {
      method: 'POST',
      body: { email: PLATFORM_SUPPORT_EMAIL, password: initialPlatformPwd },
    });
    assert(
      firstLogin.status === 200 &&
        Boolean(firstLogin.data?.data?.token) &&
        firstLogin.data?.data?.admin?.must_change_password === true,
      'Login plataforma correcto responde 200 con token y must_change_password = true',
      firstLogin
    );

    const tempPlatformToken = firstLogin.data?.data?.token;
    const decodedPlatformJwt = jwt.decode(tempPlatformToken);
    assert(
      decodedPlatformJwt?.scope === 'platform' &&
        decodedPlatformJwt?.platform_admin_id === platformAdminId &&
        decodedPlatformJwt?.company_id === undefined &&
        decodedPlatformJwt?.exp - decodedPlatformJwt?.iat === 8 * 3600,
      'JWT de plataforma contiene scope="platform", platform_admin_id, sin company_id y expira en 8h',
      decodedPlatformJwt
    );

    const blockedCompanies = await request('/platform/companies', {
      headers: { Authorization: `Bearer ${tempPlatformToken}` },
    });
    assert(
      blockedCompanies.status === 403 &&
        blockedCompanies.data?.error?.code === 'PASSWORD_CHANGE_REQUIRED',
      'Con must_change_password = true, GET /api/platform/companies responde 403 PASSWORD_CHANGE_REQUIRED',
      blockedCompanies
    );

    const weakPwd = await request('/platform/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tempPlatformToken}` },
      body: { current_password: initialPlatformPwd, new_password: '123' },
    });
    assert(
      weakPwd.status === 422 && weakPwd.data?.error?.code === 'INVALID_PASSWORD',
      'POST /api/platform/auth/change-password aplica passwordPolicy.js (débil -> 422)',
      weakPwd
    );

    const changePwdOk = await request('/platform/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tempPlatformToken}` },
      body: { current_password: initialPlatformPwd, new_password: rotatedPlatformPwd },
    });
    assert(
      changePwdOk.status === 200 && changePwdOk.data?.success === true,
      'POST /api/platform/auth/change-password actualiza contraseña y desbloquea plataforma',
      changePwdOk
    );

    // Re-login con nueva contraseña
    const activeLogin = await request('/platform/auth/login', {
      method: 'POST',
      body: { email: PLATFORM_SUPPORT_EMAIL, password: rotatedPlatformPwd },
    });
    assert(
      activeLogin.status === 200 && activeLogin.data?.data?.admin?.must_change_password === false,
      'Nuevo login plataforma confirma must_change_password = false',
      activeLogin
    );
    const platformToken = activeLogin.data?.data?.token;

    // 3. Aislamiento cruzado de tokens (taller <-> plataforma)
    console.log('\n--- 2. Aislamiento cruzado de tokens (taller vs plataforma) ---');

    const adminALogin = await request('/auth/login', {
      method: 'POST',
      body: { email: companyA.adminEmail, password: companyA.adminPassword },
    });
    assert(adminALogin.status === 200, 'Login de Admin Taller A responde 200', adminALogin);
    const adminAToken = adminALogin.data?.data?.token;

    const adminOnPlatform = await request('/platform/companies', {
      headers: { Authorization: `Bearer ${adminAToken}` },
    });
    assert(
      adminOnPlatform.status === 401,
      'Token de taller (Admin A) en /api/platform/companies responde 401',
      adminOnPlatform
    );

    const platformOnInventory = await request('/inventory', {
      headers: { Authorization: `Bearer ${platformToken}` },
    });
    assert(
      platformOnInventory.status === 401,
      'Token de plataforma en /api/inventory responde 401',
      platformOnInventory
    );

    const platformOnUsers = await request('/users', {
      headers: { Authorization: `Bearer ${platformToken}` },
    });
    assert(
      platformOnUsers.status === 401,
      'Token de plataforma en /api/users responde 401',
      platformOnUsers
    );

    const forgedPlatformScopeWithWorkshopSecret = jwt.sign(
      { platform_admin_id: platformAdminId, scope: 'platform' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const forgedWorkshopAccess = await request('/users', {
      headers: { Authorization: `Bearer ${forgedPlatformScopeWithWorkshopSecret}` },
    });
    assert(
      forgedWorkshopAccess.status === 401,
      'authenticate de talleres rechaza con 401 tokens con scope="platform"',
      forgedWorkshopAccess
    );

    // 4. Métricas, listado y detalle sin datos de negocio
    console.log('\n--- 3. Métricas, listado de talleres y cero datos de negocio ---');

    const metricsRes = await request('/platform/metrics', {
      headers: { Authorization: `Bearer ${platformToken}` },
    });
    const metrics = metricsRes.data?.data;
    assert(
      metricsRes.status === 200 &&
        metrics?.by_status &&
        typeof metrics.by_status.trial === 'number' &&
        typeof metrics.by_status.active === 'number' &&
        typeof metrics.by_status.grace === 'number' &&
        typeof metrics.by_status.suspended === 'number' &&
        typeof metrics.by_status.inactive === 'number' &&
        typeof metrics.estimated_monthly_revenue_pen === 'number' &&
        typeof metrics.ai_scans_this_month === 'number' &&
        typeof metrics.new_companies_last_30_days === 'number',
      'GET /api/platform/metrics devuelve distribución por estado, ingreso estimado, escaneos IA y altas 30d',
      metricsRes
    );

    const companiesRes = await request('/platform/companies', {
      headers: { Authorization: `Bearer ${platformToken}` },
    });
    const list = companiesRes.data?.data || [];
    const foundA = list.find((c) => c.id === companyA.companyId);
    const foundB = list.find((c) => c.id === companyB.companyId);
    assert(
      companiesRes.status === 200 &&
        Boolean(foundA) &&
        Boolean(foundB) &&
        typeof foundA.users_active === 'number' &&
        typeof foundA.ai_scans_this_month === 'number' &&
        foundA.max_users !== undefined &&
        foundA.max_ai_scans_month !== undefined,
      'GET /api/platform/companies incluye [PRUEBA] Taller A y B con sus conteos operativos',
      { foundA, foundB }
    );

    const searchUnaccentRes = await request(
      '/platform/companies?search=' + encodeURIComponent('Tállér A'),
      { headers: { Authorization: `Bearer ${platformToken}` } }
    );
    assert(
      searchUnaccentRes.status === 200 &&
        (searchUnaccentRes.data?.data || []).some((c) => c.id === companyA.companyId),
      'GET /api/platform/companies?search= aplica unaccent correctamente',
      searchUnaccentRes.data
    );

    const detailRes = await request(`/platform/companies/${companyA.companyId}`, {
      headers: { Authorization: `Bearer ${platformToken}` },
    });
    const detail = detailRes.data?.data;
    const allKeys = collectObjectKeys(detail);
    const forbiddenKeys = [
      'customer_name',
      'customer_phone',
      'placa',
      'total_amount',
      'products',
      'productos',
      'password_hash',
      'pse_token',
    ];
    const leakedKeys = forbiddenKeys.filter((k) => allKeys.has(k));
    const serializedDetail = JSON.stringify(detail);
    const leakedBusinessValues = ['PLA-9999', 'Cliente A Prueba', '999111222', '[PRUEBA] Cilindro A']
      .filter((val) => serializedDetail.includes(val));

    assert(
      detailRes.status === 200 &&
        Array.isArray(detail?.payments) &&
        Array.isArray(detail?.users) &&
        typeof detail?.monthly_counts?.invoices_issued === 'number' &&
        typeof detail?.monthly_counts?.work_orders_created === 'number' &&
        typeof detail?.monthly_counts?.active_products_count === 'number' &&
        leakedKeys.length === 0 &&
        leakedBusinessValues.length === 0,
      'GET /api/platform/companies/:id expone solo metadatos/conteos y NO contiene claves ni datos de negocio',
      { leakedKeys, leakedBusinessValues, keys: [...allKeys] }
    );

    // 5. Reset password de usuario de taller + auditoría dual
    console.log('\n--- 4. Reset password de usuario + auditoría dual ---');

    const resetRes = await request(
      `/platform/companies/${companyA.companyId}/users/${companyA.mechanicId}/reset-password`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${platformToken}` },
      }
    );
    const generatedUserTempPwd = resetRes.data?.data?.temporary_password;
    assert(
      resetRes.status === 200 &&
        typeof generatedUserTempPwd === 'string' &&
        generatedUserTempPwd.length >= 8 &&
        resetRes.data?.data?.user?.must_change_password === true,
      'POST reset-password responde 200 con contraseña temporal y must_change_password = true',
      { status: resetRes.status, user: resetRes.data?.data?.user }
    );

    const { rows: userDbRows } = await pool.query(
      'SELECT must_change_password FROM users WHERE id = $1',
      [companyA.mechanicId]
    );
    assert(
      userDbRows[0]?.must_change_password === true,
      'BD confirma must_change_password = true en el usuario afectado',
      userDbRows[0]
    );

    const { rows: platAuditResetRows } = await pool.query(
      `SELECT id, action, target_company_id, target_user_id
       FROM platform_audit_logs
       WHERE platform_admin_id = $1
         AND action = 'user_password_reset'
         AND target_company_id = $2
         AND target_user_id = $3
       ORDER BY id DESC LIMIT 1`,
      [platformAdminId, companyA.companyId, companyA.mechanicId]
    );
    assert(
      platAuditResetRows.length === 1,
      'Existe registro en platform_audit_logs para user_password_reset',
      platAuditResetRows
    );

    const { rows: workshopAuditResetRows } = await pool.query(
      `SELECT id, entity, action, entity_id, changes
       FROM audit_logs
       WHERE company_id = $1
         AND entity = 'platform_support'
         AND action = 'password_reset'
         AND entity_id = $2
       ORDER BY id DESC LIMIT 1`,
      [companyA.companyId, companyA.mechanicId]
    );
    assert(
      workshopAuditResetRows.length === 1 &&
        String(workshopAuditResetRows[0].changes?.message || '').includes('Soporte MotoTrack restableció la contraseña'),
      'Existe registro en audit_logs del taller con entity="platform_support" visible para el admin',
      workshopAuditResetRows
    );

    const adminAuditView = await request('/audit?entity=platform_support', {
      headers: { Authorization: `Bearer ${adminAToken}` },
    });
    const adminAuditLogs = adminAuditView.data?.data?.logs || [];
    assert(
      adminAuditView.status === 200 &&
        adminAuditLogs.some((log) => log.entity === 'platform_support' && log.action === 'password_reset'),
      'Admin Taller A consulta GET /api/audit?entity=platform_support y visualiza la acción de Soporte',
      adminAuditView
    );

    // 6. Suspender / reactivar taller y validación de reason
    console.log('\n--- 5. Suspender y reactivar taller + validación de motivo ---');

    const shortReasonRes = await request(`/platform/companies/${companyA.companyId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${platformToken}` },
      body: { is_active: false, reason: 'corto' },
    });
    assert(
      shortReasonRes.status === 422,
      'PATCH /companies/:id/status con reason muy corto responde 422',
      shortReasonRes
    );

    const suspendRes = await request(`/platform/companies/${companyA.companyId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${platformToken}` },
      body: { is_active: false, reason: 'Suspensión de prueba automatizada P1 por verificación' },
    });
    assert(
      suspendRes.status === 200 && suspendRes.data?.data?.is_active === false,
      'Suspender Taller A actualiza is_active = false',
      suspendRes
    );

    const adminLoginWhileSuspended = await request('/auth/login', {
      method: 'POST',
      body: { email: companyA.adminEmail, password: companyA.adminPassword },
    });
    assert(
      adminLoginWhileSuspended.status === 403 &&
        adminLoginWhileSuspended.data?.error?.code === 'COMPANY_INACTIVE',
      'Login de Admin Taller A mientras está suspendido responde 403 COMPANY_INACTIVE',
      adminLoginWhileSuspended
    );

    const reactivateRes = await request(`/platform/companies/${companyA.companyId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${platformToken}` },
      body: { is_active: true, reason: 'Reactivación de Taller A tras prueba automatizada P1' },
    });
    assert(
      reactivateRes.status === 200 && reactivateRes.data?.data?.is_active === true,
      'Reactivar Taller A actualiza is_active = true',
      reactivateRes
    );

    const adminLoginAfterReactivate = await request('/auth/login', {
      method: 'POST',
      body: { email: companyA.adminEmail, password: companyA.adminPassword },
    });
    assert(
      adminLoginAfterReactivate.status === 200 && Boolean(adminLoginAfterReactivate.data?.data?.token),
      'Login de Admin Taller A tras reactivación responde 200',
      adminLoginAfterReactivate
    );

    // 7. Pago de suscripción vía recordPayment + consulta /api/platform/audit
    console.log('\n--- 6. Pago de suscripción, /audit e inmutabilidad ---');

    const payRes = await request(`/platform/companies/${companyB.companyId}/payments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${platformToken}` },
      body: {
        amount: 99,
        method: 'yape',
        reference: 'P1-YAPE-001',
        months: 1,
        notes: 'Pago de suscripción de prueba P1',
      },
    });
    assert(
      payRes.status === 201 &&
        payRes.data?.data?.payment?.amount === 99 &&
        Boolean(payRes.data?.data?.company?.paid_until),
      'POST /companies/:id/payments reutiliza recordPayment y responde 201',
      payRes
    );

    const auditEndpointRes = await request(
      `/platform/audit?company_id=${companyA.companyId}`,
      { headers: { Authorization: `Bearer ${platformToken}` } }
    );
    const auditLogs = auditEndpointRes.data?.data?.logs || [];
    assert(
      auditEndpointRes.status === 200 &&
        auditLogs.length >= 3 &&
        auditLogs.every((l) => l.target_company_id === companyA.companyId),
      'GET /api/platform/audit?company_id= retorna las acciones filtradas para Taller A',
      { count: auditLogs.length }
    );

    const sampleAuditId = platAuditResetRows[0].id;
    let updateFailed = false;
    try {
      await pool.query(`UPDATE platform_audit_logs SET action = 'mutado' WHERE id = $1`, [sampleAuditId]);
    } catch (err) {
      updateFailed = err.message.includes('inmutable');
    }
    assert(updateFailed, 'UPDATE sobre platform_audit_logs falla por trigger de inmutabilidad');

    let deleteFailed = false;
    try {
      await pool.query(`DELETE FROM platform_audit_logs WHERE id = $1`, [sampleAuditId]);
    } catch (err) {
      deleteFailed = err.message.includes('inmutable');
    }
    assert(deleteFailed, 'DELETE sobre platform_audit_logs falla por trigger de inmutabilidad');

    // 8. Script CLI create-platform-admin.js y estado 503 sin PLATFORM_JWT_SECRET
    console.log('\n--- 7. Script CLI create-platform-admin.js y guard 503 sin PLATFORM_JWT_SECRET ---');

    disposableCliEmail = `prueba.cli.${Date.now()}@mototrack.local`;
    const cliRun = spawnSync(
      process.execPath,
      [
        path.resolve(ROOT_DIR, 'scripts/create-platform-admin.js'),
        '--email',
        disposableCliEmail,
        '--name',
        '[PRUEBA] CLI Temp',
      ],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    const tempMatch = cliRun.stdout.match(/Contraseña temporal\s*:\s*(\S+)/);
    const cliTempPassword = tempMatch ? tempMatch[1] : null;
    assert(
      cliRun.status === 0 && Boolean(cliTempPassword) && cliTempPassword.length >= 8,
      'CLI create-platform-admin.js crea admin con must_change_password = true y contraseña aleatoria',
      { status: cliRun.status }
    );

    const cliLogin = await request('/platform/auth/login', {
      method: 'POST',
      body: { email: disposableCliEmail, password: cliTempPassword },
    });
    assert(
      cliLogin.status === 200 && cliLogin.data?.data?.admin?.must_change_password === true,
      'Admin creado por CLI puede iniciar sesión con contraseña temporal y must_change_password = true',
      cliLogin
    );

    // Probar ausencia de PLATFORM_JWT_SECRET usando la instancia Express real sin reiniciar Docker
    const originalPlatformSecret = process.env.PLATFORM_JWT_SECRET;
    delete process.env.PLATFORM_JWT_SECRET;

    const ephemeralServer = await new Promise((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    try {
      const port = ephemeralServer.address().port;
      const ephemeralBase = `http://127.0.0.1:${port}/api`;

      const unconfiguredPlatform = await request(
        '/platform/auth/login',
        { method: 'POST', body: { email: PLATFORM_SUPPORT_EMAIL, password: rotatedPlatformPwd } },
        ephemeralBase
      );
      const healthyEndpoint = await request('/health', {}, ephemeralBase);

      assert(
        unconfiguredPlatform.status === 503 &&
          unconfiguredPlatform.data?.error?.code === 'PLATFORM_NOT_CONFIGURED' &&
          healthyEndpoint.status === 200,
        'Con PLATFORM_JWT_SECRET ausente, /api/platform/* responde 503 y el resto del sistema sigue funcionando',
        { platformStatus: unconfiguredPlatform.status, healthStatus: healthyEndpoint.status }
      );
    } finally {
      if (originalPlatformSecret !== undefined) {
        process.env.PLATFORM_JWT_SECRET = originalPlatformSecret;
      }
      await new Promise((resolve) => ephemeralServer.close(resolve));
    }
  } catch (err) {
    console.error('\n💥 Error inesperado en verify-p1:', err);
    failedTests++;
    totalTests++;
  } finally {
    // Regla 8: desactivar entidades [PRUEBA]
    try {
      if (disposableCliEmail) {
        await pool.query('DELETE FROM platform_admins WHERE LOWER(email) = $1', [
          disposableCliEmail.toLowerCase(),
        ]);
      }
      await pool.query(
        `UPDATE platform_admins SET is_active = false, updated_at = NOW() WHERE LOWER(email) = $1`,
        [PLATFORM_SUPPORT_EMAIL]
      );
      if (companyA && companyB) {
        await pool.query(
          `UPDATE companies SET is_active = false, status = 'active', paid_until = NULL WHERE id IN ($1, $2)`,
          [companyA.companyId, companyB.companyId]
        );
        await pool.query(
          `UPDATE users SET is_active = false WHERE company_id IN ($1, $2)`,
          [companyA.companyId, companyB.companyId]
        );
      }
    } catch (cleanupErr) {
      console.error('⚠️ Error en limpieza de verify-p1:', cleanupErr.message);
    }
    await pool.end();
  }

  console.log('\n===============================================================');
  console.log(`📊  RESULTADOS: ${passedTests}/${totalTests} pruebas pasaron (${failedTests} fallaron)`);
  console.log('===============================================================\n');

  process.exit(failedTests > 0 ? 1 : 0);
}

run();
