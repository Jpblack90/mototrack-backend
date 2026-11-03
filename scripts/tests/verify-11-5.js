// =============================================================================
// scripts/tests/verify-11-5.js
// Suite de verificación integral de la Tarea 11.5:
// Registro de talleres nuevos (onboarding), trial de 14 días, activación, rate limiting y aislamiento.
// Solo utiliza razones sociales con prefijo "[PRUEBA]".
// =============================================================================

import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import pool from '../../src/config/database.js';

const execFileAsync = promisify(execFile);

if (process.env.NODE_ENV === 'production') {
  console.error('❌  Error: verify-11-5.js no debe ejecutarse en entorno de producción.');
  process.exit(1);
}

const API_BASE = process.env.API_URL || 'http://localhost:4000/api';

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
    // respuesta sin cuerpo JSON
  }

  return { status: res.status, ok: res.ok, data };
}

async function run() {
  console.log('\n===============================================================');
  console.log('🚀  VERIFICACIÓN INTEGRAL: TAREA 11.5 (ONBOARDING & TRIAL)');
  console.log('===============================================================\n');

  const createdCompanyIds = [];
  let registeredToken = null;
  let registeredCompanyId = null;
  const testEmail = `taller.onboarding.${Date.now()}@mototrack.local`;
  const testPassword = 'Password123!';

  // Limpieza preventiva: liberar RUC de pruebas previas interrumpidas
  await pool.query(`UPDATE companies SET ruc = NULL WHERE razon_social LIKE '[PRUEBA] Taller Onboarding%'`);

  try {
    // 0. Conteo inicial de "Taller Principal" para verificar que no sea tocado
    const { rows: realCo } = await pool.query(
      `SELECT id FROM companies WHERE razon_social = 'Taller Principal'`
    );
    const realCompanyId = realCo[0]?.id;
    let initialRealCounts = null;
    if (realCompanyId) {
      const { rows: realSales } = await pool.query('SELECT COUNT(*)::int AS count FROM sales WHERE company_id = $1', [realCompanyId]);
      const { rows: realInvoices } = await pool.query('SELECT COUNT(*)::int AS count FROM invoices WHERE company_id = $1', [realCompanyId]);
      const { rows: realWorkorders } = await pool.query('SELECT COUNT(*)::int AS count FROM work_orders WHERE company_id = $1', [realCompanyId]);
      initialRealCounts = {
        sales: realSales[0].count,
        invoices: realInvoices[0].count,
        workorders: realWorkorders[0].count,
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 1: Validaciones de Registro (RUC inválido, Sin términos, Email repetido)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 1: Validaciones previas en POST /api/auth/register-company ---');

    // 1a: RUC inválido (falla Módulo 11)
    const r1a = await request('/auth/register-company', {
      method: 'POST',
      body: {
        razon_social: '[PRUEBA] Taller RUC Invalido',
        admin_name: 'Admin Prueba',
        email: 'ruc_invalido@prueba.local',
        password: 'Password123!',
        ruc: '20123456789', // RUC inválido
        accept_terms: true,
      },
    });
    assert(
      r1a.status === 422 && r1a.data?.error?.code === 'INVALID_RUC',
      'Registro con RUC inválido es rechazado con 422 INVALID_RUC',
      `status: ${r1a.status}, code: ${r1a.data?.error?.code}`
    );

    // 1b: Sin accept_terms o false
    const r1b = await request('/auth/register-company', {
      method: 'POST',
      body: {
        razon_social: '[PRUEBA] Taller Sin Terminos',
        admin_name: 'Admin Prueba',
        email: 'sin_terminos@prueba.local',
        password: 'Password123!',
        accept_terms: false,
      },
    });
    assert(
      r1b.status === 422 && r1b.data?.error?.code === 'TERMS_NOT_ACCEPTED',
      'Registro sin aceptar términos es rechazado con 422 TERMS_NOT_ACCEPTED',
      `status: ${r1b.status}, code: ${r1b.data?.error?.code}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 2: Registro Exitoso de Taller Nuevo (201)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 2: Registro exitoso de nuevo taller (201 y token funcional) ---');
    const rRegister = await request('/auth/register-company', {
      method: 'POST',
      body: {
        razon_social: '[PRUEBA] Taller Onboarding Express S.A.C.',
        nombre_comercial: 'Taller Express Onboarding',
        ruc: '20123456786', // RUC válido Módulo 11
        admin_name: 'Juan Perez Dueño',
        email: testEmail,
        password: testPassword,
        accept_terms: true,
      },
    });

    assert(
      rRegister.status === 201,
      'POST /api/auth/register-company responde 201 Created',
      `status: ${rRegister.status}`
    );

    const regData = rRegister.data?.data;
    registeredToken = regData?.token;
    registeredCompanyId = regData?.user?.company_id;
    if (registeredCompanyId) createdCompanyIds.push(registeredCompanyId);

    assert(
      Boolean(registeredToken) && regData?.user?.role === 'admin',
      'Registro devuelve token JWT y usuario con rol admin',
      `user: ${JSON.stringify(regData?.user)}`
    );
    assert(
      regData?.user?.must_change_password === false,
      'Usuario nuevo tiene must_change_password = false (eligió su contraseña)',
      `must_change_password: ${regData?.user?.must_change_password}`
    );

    // 1c: Intentar registrar de nuevo con el mismo email -> 409
    const r1c = await request('/auth/register-company', {
      method: 'POST',
      body: {
        razon_social: '[PRUEBA] Taller Duplicado',
        admin_name: 'Otro Admin',
        email: testEmail,
        password: 'Password123!',
        accept_terms: true,
      },
    });
    assert(
      r1c.status === 409 && r1c.data?.error?.code === 'EMAIL_ALREADY_EXISTS',
      'Registro con email ya existente es rechazado con 409 EMAIL_ALREADY_EXISTS',
      `status: ${r1c.status}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 3: Consulta de Configuración de Empresa con Token de Onboarding
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 3: Token del nuevo taller accede a /api/company con datos de trial ---');
    const rCompany = await request('/company', {
      headers: { Authorization: `Bearer ${registeredToken}` },
    });
    assert(
      rCompany.status === 200,
      'Token de registro permite acceder a GET /api/company (200)',
      `status: ${rCompany.status}`
    );
    const compData = rCompany.data?.data;
    assert(
      compData?.status === 'trial' &&
      Number(compData?.days_left) >= 13 &&
      Boolean(compData?.trial_ends_at),
      'Empresa creada se inicializa en status "trial", con trial_ends_at y days_left = 14',
      `status: ${compData?.status}, days_left: ${compData?.days_left}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 4: Aislamiento Multi-Tenant del Nuevo Taller
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 4: Aislamiento de datos del nuevo taller ---');
    const [rInv, rSales, rWo] = await Promise.all([
      request('/inventory', { headers: { Authorization: `Bearer ${registeredToken}` } }),
      request('/sales', { headers: { Authorization: `Bearer ${registeredToken}` } }),
      request('/workorders', { headers: { Authorization: `Bearer ${registeredToken}` } }),
    ]);

    assert(
      rInv.status === 200 && Array.isArray(rInv.data?.data) && rInv.data.data.length === 0,
      'Nuevo taller tiene catálogo de inventario vacío (0 productos de otros talleres)'
    );
    assert(
      rSales.status === 200 && Array.isArray(rSales.data?.data) && rSales.data.data.length === 0,
      'Nuevo taller tiene listado de ventas vacío (0 ventas de otros talleres)'
    );
    assert(
      rWo.status === 200 && Array.isArray(rWo.data?.data) && rWo.data.data.length === 0,
      'Nuevo taller tiene listado de órdenes vacío (0 órdenes de otros talleres)'
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 5: Periodo de Prueba Vencido (TRIAL_EXPIRED - 403)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 5: Expiración de periodo de prueba (TRIAL_EXPIRED -> 403) ---');
    // Forzar fecha de trial_ends_at al pasado en la BD
    await pool.query(
      `UPDATE companies SET trial_ends_at = NOW() - INTERVAL '2 days' WHERE id = $1`,
      [registeredCompanyId]
    );

    // 5a: Intento de login con prueba vencida -> 403 TRIAL_EXPIRED
    const rLoginExpired = await request('/auth/login', {
      method: 'POST',
      body: { email: testEmail, password: testPassword },
    });
    assert(
      rLoginExpired.status === 403 &&
      rLoginExpired.data?.error?.code === 'TRIAL_EXPIRED' &&
      rLoginExpired.data?.error?.message?.includes('Tu periodo de prueba terminó'),
      'Login con periodo de prueba vencido es bloqueado con 403 TRIAL_EXPIRED',
      `status: ${rLoginExpired.status}, error: ${JSON.stringify(rLoginExpired.data?.error)}`
    );

    // 5b: Petición con token existente y prueba vencida -> 403 TRIAL_EXPIRED en authenticate.js
    const rReqExpired = await request('/company', {
      headers: { Authorization: `Bearer ${registeredToken}` },
    });
    assert(
      rReqExpired.status === 403 &&
      rReqExpired.data?.error?.code === 'TRIAL_EXPIRED',
      'Petición con token existente y periodo de prueba vencido es bloqueada con 403 TRIAL_EXPIRED',
      `status: ${rReqExpired.status}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 6: Activación de Empresa con scripts/activate-company.js
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 6: Activación de empresa vía scripts/activate-company.js ---');
    const scriptPath = path.resolve('scripts/activate-company.js');
    const { stdout, stderr } = await execFileAsync('node', [scriptPath, String(registeredCompanyId)], {
      env: { ...process.env, DB_PORT: process.env.DB_PORT || '5433' },
    });

    const outputHasSuccess = stdout.includes('activada exitosamente');
    assert(
      outputHasSuccess,
      'Script scripts/activate-company.js se ejecutó con éxito',
      stdout.trim()
    );

    // Verificar en BD que status = 'active' y trial_ends_at = null
    const { rows: activatedRows } = await pool.query(
      'SELECT status, trial_ends_at FROM companies WHERE id = $1',
      [registeredCompanyId]
    );
    assert(
      activatedRows[0].status === 'active' && activatedRows[0].trial_ends_at === null,
      'Empresa pasa a status "active" y trial_ends_at es NULL tras la activación'
    );

    // Verificar en audit_logs el evento de activación
    const { rows: auditRows } = await pool.query(
      `SELECT action, user_id, changes FROM audit_logs WHERE company_id = $1 AND action = 'activate'`,
      [registeredCompanyId]
    );
    assert(
      auditRows.length > 0 && auditRows[0].user_id === null,
      'Evento de activación registrado en audit_logs con action="activate" y user_id=NULL'
    );

    // Verificar que login y peticiones vuelven a responder 200
    const rLoginAfterActivate = await request('/auth/login', {
      method: 'POST',
      body: { email: testEmail, password: testPassword },
    });
    assert(
      rLoginAfterActivate.status === 200,
      'Tras activación, login vuelve a responder 200 OK exitosamente'
    );

    const rCompanyAfterActivate = await request('/company', {
      headers: { Authorization: `Bearer ${registeredToken}` },
    });
    assert(
      rCompanyAfterActivate.status === 200 && rCompanyAfterActivate.data?.data?.status === 'active',
      'Petición con token vuelve a responder 200 OK con status "active"'
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 7: Rate limiting global de login por IP (50 fallidos -> intento 51 da 429)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 7: Rate limiting global por IP (50 fallidos con emails distintos -> intento 51 da 429) ---');
    const runTimestamp = Date.now();
    let allFirst50Are401 = true;
    for (let i = 1; i <= 50; i++) {
      const emailDistinct = `enum_target_${runTimestamp}_${i}@mototrack.local`;
      const res = await request('/auth/login', {
        method: 'POST',
        body: { email: emailDistinct, password: 'ContrasenaIncorrecta123!' },
      });
      if (res.status !== 401) {
        allFirst50Are401 = false;
        console.error(`  Intento ${i} devolvió status ${res.status} en vez de 401:`, res.data);
        break;
      }
    }
    assert(
      allFirst50Are401,
      '50 logins fallidos con 50 emails distintos desde la misma IP devuelven 401 INVALID_CREDENTIALS'
    );

    // Intento 51 con un 51-ésimo email distinto debe devolver 429
    const email51 = `enum_target_${runTimestamp}_51@mototrack.local`;
    const res51 = await request('/auth/login', {
      method: 'POST',
      body: { email: email51, password: 'ContrasenaIncorrecta123!' },
    });
    assert(
      res51.status === 429 &&
      res51.data?.error?.code === 'TOO_MANY_REQUESTS' &&
      res51.data?.error?.message?.includes('Demasiados intentos'),
      'El login número 51 con email distinto es bloqueado con 429 TOO_MANY_REQUESTS por límite de IP',
      `status: ${res51.status}, data: ${JSON.stringify(res51.data)}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 7b: X-Forwarded-For falsificado NO evita el 429 (con TRUST_PROXY sin definir)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 7b: Petición con X-Forwarded-For falsificado NO evita el 429 ---');
    const emailSpoofed = `spoof_target_${runTimestamp}@mototrack.local`;
    const resSpoofed = await request('/auth/login', {
      method: 'POST',
      headers: {
        'X-Forwarded-For': '203.0.113.199, 198.51.100.25',
      },
      body: { email: emailSpoofed, password: 'ContrasenaIncorrecta123!' },
    });
    assert(
      resSpoofed.status === 429 &&
      resSpoofed.data?.error?.code === 'TOO_MANY_REQUESTS' &&
      resSpoofed.data?.error?.message?.includes('Demasiados intentos'),
      'Petición con X-Forwarded-For falsificado NO evita el 429 (con TRUST_PROXY sin definir / false)',
      `status: ${resSpoofed.status}, data: ${JSON.stringify(resSpoofed.data)}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 8: Integridad de Taller Principal
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 8: Verificación de Integridad de Taller Principal ---');
    if (realCompanyId && initialRealCounts) {
      const { rows: realSales } = await pool.query('SELECT COUNT(*)::int AS count FROM sales WHERE company_id = $1', [realCompanyId]);
      const { rows: realInvoices } = await pool.query('SELECT COUNT(*)::int AS count FROM invoices WHERE company_id = $1', [realCompanyId]);
      const { rows: realWorkorders } = await pool.query('SELECT COUNT(*)::int AS count FROM work_orders WHERE company_id = $1', [realCompanyId]);

      const salesUntouched = realSales[0].count === initialRealCounts.sales;
      const invUntouched = realInvoices[0].count === initialRealCounts.invoices;
      const woUntouched = realWorkorders[0].count === initialRealCounts.workorders;

      assert(
        salesUntouched && invUntouched && woUntouched,
        'Taller Principal (empresa real) no sufrió modificaciones tras la suite de onboarding'
      );
    }

  } catch (err) {
    console.error('💥  Error inesperado durante la verificación:', err);
    failedTests++;
  } finally {
    // Desactivar empresas [PRUEBA] creadas en la suite
    if (createdCompanyIds.length > 0) {
      try {
        await pool.query(
          `UPDATE companies SET is_active = false, ruc = NULL
           WHERE id = ANY($1::int[]) AND razon_social LIKE '[PRUEBA]%'`,
          [createdCompanyIds]
        );
        console.log(`\n🧹  Limpieza: ${createdCompanyIds.length} empresa(s) [PRUEBA] desactivadas lógicamente.`);
      } catch (cleanErr) {
        console.error('Error en limpieza:', cleanErr.message);
      }
    }
    await pool.end();
  }

  console.log('\n===============================================================');
  console.log(`📊  RESULTADOS: ${passedTests}/${totalTests} pruebas pasaron.`);
  if (failedTests > 0) {
    console.log(`❌  ${failedTests} prueba(s) fallaron.`);
    console.log('===============================================================\n');
    process.exit(1);
  } else {
    console.log('🎉  TODAS LAS PRUEBAS DE LA TAREA 11.5 PASARON EXITOSAMENTE.');
    console.log('===============================================================\n');
    process.exit(0);
  }
}

run();
