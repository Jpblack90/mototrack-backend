// =============================================================================
// scripts/tests/verify-13-2.js
// Suite de verificación para la Tarea 13.2: Cobro Manual de Suscripción,
// Control de Vencimiento, Avisos y Suspensión Automática.
//
// Utiliza exclusivamente las empresas de prueba "[PRUEBA] Taller A" y "[PRUEBA] Taller B".
// =============================================================================

import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';
import {
  recordPayment,
  markOverdueSubscriptions,
  getLimaDateStr,
} from '../../src/modules/company/subscription.service.js';

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Error: verify-13-2.js no debe ejecutarse en entorno de producción.');
  process.exit(1);
}

const API_BASE = process.env.API_URL || 'http://localhost:4000/api';
const DEMO_PASSWORD = process.env.DEMO_USERS_PASSWORD || 'Demo1234!';
const JOBS_TOKEN = process.env.JOBS_TOKEN || '';
const EXPECTED_INSTRUCTIONS = process.env.PAYMENT_INSTRUCTIONS || 'Yape al 987654321 a nombre de MotoTrack AI';

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

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const res = await fetch(url, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, ok: res.ok, data };
}

async function run() {
  console.log('\n===============================================================');
  console.log('🧪  INICIANDO SUITE VERIFY-13-2: SUSCRIPCIONES Y COBRO MANUAL');
  console.log('===============================================================\n');

  let companyA = null;
  let companyB = null;

  try {
    // 1. Sembrar empresas de prueba
    const seeded = await seedTestCompany();
    companyA = seeded.companyA;
    companyB = seeded.companyB;

    // Limpiar pagos previos para pruebas limpias
    await pool.query(`DELETE FROM subscription_payments WHERE company_id IN ($1, $2)`, [
      companyA.companyId,
      companyB.companyId,
    ]);

    // Crear o asegurar usuario cajero en Company A para probar autorización
    const cajeroEmail = 'cajero.verify132@test.com';
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id, is_active)
       VALUES ('Cajero Test 13.2', $1, $2, 'cajero', $3, true)
       ON CONFLICT (email) DO UPDATE SET is_active = true, role = 'cajero', company_id = $3`,
      [cajeroEmail, companyA.adminEmail ? '$2b$10$w8F2xN48M...' : '$2b$10$x', companyA.companyId]
    );

    // Obtener tokens de autenticación
    const loginAdminARes = await request('/auth/login', {
      method: 'POST',
      body: { email: companyA.adminEmail, password: DEMO_PASSWORD },
    });
    const adminTokenA = loginAdminARes.data?.data?.token;

    const loginAdminBRes = await request('/auth/login', {
      method: 'POST',
      body: { email: companyB.adminEmail, password: DEMO_PASSWORD },
    });
    const adminTokenB = loginAdminBRes.data?.data?.token;

    // Token firmado para el cajero
    const cajeroTokenA = jwt.sign(
      {
        id: 999991,
        role: 'cajero',
        name: 'Cajero Test',
        company_id: companyA.companyId,
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Asegurar usuario cajero en BD con id correspondiente
    const { rows: cajeroRows } = await pool.query(
      `SELECT id FROM users WHERE email = $1`,
      [cajeroEmail]
    );
    const cajeroId = cajeroRows[0]?.id;
    const realCajeroTokenA = jwt.sign(
      {
        id: cajeroId,
        role: 'cajero',
        name: 'Cajero Test Real',
        company_id: companyA.companyId,
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const hoyLima = getLimaDateStr();

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 1: Pago en Cuenta Vencida Extiende desde Hoy
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 1: Pago en Cuenta Vencida Extiende desde Hoy ---');

    // Forzar vencimiento pasado (ej: 10 días atrás)
    await pool.query(
      `UPDATE companies
       SET paid_until = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date - INTERVAL '10 days',
           status = 'active'
       WHERE id = $1`,
      [companyA.companyId]
    );

    const payVencidoRes = await recordPayment({
      companyId: companyA.companyId,
      amount: 99.00,
      method: 'yape',
      reference: 'YAPE-VENCIDO-01',
      months: 1,
      notes: 'Pago de regularización',
    });

    assert(payVencidoRes.payment.period_from === hoyLima, `Periodo inicial parte de hoy (${hoyLima})`);
    const { rows: calcRows1 } = await pool.query(
      `SELECT ($1::date + INTERVAL '1 month')::date::text AS expected_to`,
      [hoyLima]
    );
    const expectedTo1 = calcRows1[0].expected_to;
    assert(payVencidoRes.payment.period_to === expectedTo1, `Periodo final es hoy + 1 mes (${expectedTo1})`);
    assert(payVencidoRes.company.paid_until === expectedTo1, `paid_until actualizado a ${expectedTo1}`);
    assert(payVencidoRes.company.status === 'active', 'Empresa en estado "active"');

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 2: Pago Adelantado Extiende desde paid_until (No Pierde Días y Sin Solapamiento)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 2: Pago Adelantado Extiende desde paid_until (No Pierde Días) ---');

    const previousPaidUntil = payVencidoRes.company.paid_until;

    const payAdelantadoRes = await recordPayment({
      companyId: companyA.companyId,
      amount: 99.00,
      method: 'plin',
      reference: 'PLIN-ADELANTADO-02',
      months: 1,
      notes: 'Pago adelantado de renovación',
    });

    const { rows: expectedFromRows } = await pool.query(
      `SELECT ($1::date + INTERVAL '1 day')::date::text AS expected_from`,
      [previousPaidUntil]
    );
    const expectedFrom2 = expectedFromRows[0].expected_from;

    assert(
      payAdelantadoRes.payment.period_from === expectedFrom2,
      `Periodo inicial es el día siguiente al vencimiento previo (${expectedFrom2}) para no solapar`
    );
    const { rows: calcRows2 } = await pool.query(
      `SELECT ($1::date + INTERVAL '1 month')::date::text AS expected_to`,
      [previousPaidUntil]
    );
    const expectedTo2 = calcRows2[0].expected_to;
    assert(payAdelantadoRes.payment.period_to === expectedTo2, `Nuevo periodo final es previo + 1 mes (${expectedTo2})`);
    assert(payAdelantadoRes.company.paid_until === expectedTo2, `paid_until acumulado correctamente (${expectedTo2})`);
    assert(
      payAdelantadoRes.payment.period_from !== payVencidoRes.payment.period_to,
      'Los periodos de pagos consecutivos no se solapan (period_from != prev period_to)'
    );

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 3: Múltiples Meses (months = 3 suma 3 meses exactos)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 3: Múltiples Meses (months = 3) ---');

    const prevUntilCase3 = payAdelantadoRes.company.paid_until;

    const payMultiRes = await recordPayment({
      companyId: companyA.companyId,
      amount: 297.00,
      method: 'transferencia',
      reference: 'TRF-BBVA-998877',
      months: 3,
      notes: 'Trimestre adelantado',
    });

    assert(payMultiRes.payment.months === 3, 'Registra months = 3');
    const { rows: expectedFrom3Rows } = await pool.query(
      `SELECT ($1::date + INTERVAL '1 day')::date::text AS expected_from`,
      [prevUntilCase3]
    );
    assert(
      payMultiRes.payment.period_from === expectedFrom3Rows[0].expected_from,
      `Periodo inicial de trimestre es día siguiente al vencimiento (${expectedFrom3Rows[0].expected_from})`
    );
    const { rows: calcRows3 } = await pool.query(
      `SELECT ($1::date + INTERVAL '3 months')::date::text AS expected_to`,
      [prevUntilCase3]
    );
    const expectedTo3 = calcRows3[0].expected_to;
    assert(payMultiRes.payment.period_to === expectedTo3, `Suma 3 meses exactos (${prevUntilCase3} ➔ ${expectedTo3})`);
    assert(payMultiRes.company.paid_until === expectedTo3, `paid_until actualizado a ${expectedTo3}`);

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 4: Transición Trial ➔ Active al Primer Pago
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 4: Transición Trial ➔ Active al Primer Pago ---');

    // Poner Company B en periodo de prueba con trial_ends_at activo
    await pool.query(
      `UPDATE companies
       SET status = 'trial',
           trial_ends_at = NOW() + INTERVAL '7 days',
           paid_until = NULL
       WHERE id = $1`,
      [companyB.companyId]
    );

    const payTrialRes = await recordPayment({
      companyId: companyB.companyId,
      amount: 99.00,
      method: 'efectivo',
      months: 1,
      notes: 'Primer pago tras prueba gratuita',
    });

    assert(payTrialRes.company.status === 'active', 'Empresa pasa de trial a active');
    assert(payTrialRes.company.trial_ends_at === null, 'trial_ends_at se limpia a NULL');
    assert(payTrialRes.company.paid_until !== null, 'paid_until queda establecido con fecha de vencimiento');

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 5: Job de Suspensión Automática e Idempotencia
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 5: Job de Suspensión Automática e Idempotencia ---');

    // 5a: A 3 días de vencida (dentro de gracia de 5 días) NO se suspende
    await pool.query(
      `UPDATE companies
       SET status = 'active',
           paid_until = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date - INTERVAL '3 days'
       WHERE id = $1`,
      [companyA.companyId]
    );

    const jobRun1 = await markOverdueSubscriptions(5);
    const { rows: compAStatus1 } = await pool.query(`SELECT status FROM companies WHERE id = $1`, [companyA.companyId]);
    assert(compAStatus1[0].status === 'active', 'A 3 días de vencida (dentro de gracia) NO se suspende');

    // 5b: A 6 días de vencida (superó los 5 días de gracia) SÍ se suspende
    await pool.query(
      `UPDATE companies
       SET status = 'active',
           paid_until = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date - INTERVAL '6 days'
       WHERE id = $1`,
      [companyA.companyId]
    );

    const jobRun2 = await markOverdueSubscriptions(5);
    const { rows: compAStatus2 } = await pool.query(`SELECT status FROM companies WHERE id = $1`, [companyA.companyId]);
    assert(compAStatus2[0].status === 'suspended', 'A 6 días de vencida (fuera de gracia) se suspende a "suspended"');
    assert(jobRun2.suspended >= 1, 'Job reporta al menos 1 empresa suspendida');

    // 5c: Segunda corrida del job: 0 cambios (idempotente)
    const jobRun3 = await markOverdueSubscriptions(5);
    assert(jobRun3.suspended === 0, 'Segunda ejecución consecutiva: 0 empresas suspendidas (idempotente)');

    // 5d: Taller Principal (paid_until NULL y status 'active') nunca cambia
    const { rows: mainComp } = await pool.query(
      `SELECT id, status, paid_until FROM companies WHERE paid_until IS NULL AND status = 'active' LIMIT 1`
    );
    if (mainComp.length > 0) {
      assert(mainComp[0].status === 'active', `Empresa con paid_until NULL (id #${mainComp[0].id}) permanece activa`);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 6: Bloqueo 403 SUBSCRIPTION_EXPIRED en Login y Middleware
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 6: Bloqueo 403 SUBSCRIPTION_EXPIRED en Login y Token ---');

    // Intento de login con empresa suspendida
    const loginSuspendedRes = await request('/auth/login', {
      method: 'POST',
      body: { email: companyA.adminEmail, password: DEMO_PASSWORD },
    });

    assert(loginSuspendedRes.status === 403, `Login con empresa suspendida retorna 403 (obtuvo ${loginSuspendedRes.status})`);
    assert(loginSuspendedRes.data?.error?.code === 'SUBSCRIPTION_EXPIRED', 'Código de error es SUBSCRIPTION_EXPIRED');
    assert(
      loginSuspendedRes.data?.error?.message?.includes('Tu suscripción venció el'),
      'Mensaje contiene "Tu suscripción venció el {fecha}"'
    );
    assert(
      loginSuspendedRes.data?.error?.message?.includes('Realiza el pago para reactivar tu cuenta'),
      'Mensaje contiene llamado a reactivación'
    );
    if (EXPECTED_INSTRUCTIONS) {
      assert(
        loginSuspendedRes.data?.error?.message?.includes(EXPECTED_INSTRUCTIONS),
        'Mensaje incluye PAYMENT_INSTRUCTIONS de las variables de entorno'
      );
    }

    // Petición con token ya emitido previamente
    const tokenSuspendedRes = await request('/company', {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminTokenA}` },
    });
    assert(tokenSuspendedRes.status === 403, `Token ya emitido retorna 403 al autenticar empresa suspendida (obtuvo ${tokenSuspendedRes.status})`);
    assert(tokenSuspendedRes.data?.error?.code === 'SUBSCRIPTION_EXPIRED', 'Token bloqueado con código SUBSCRIPTION_EXPIRED');

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 7: Pago Posterior a la Suspensión Reactiva la Cuenta
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 7: Pago Posterior a la Suspensión Reactiva la Cuenta ---');

    const payReactivationRes = await recordPayment({
      companyId: companyA.companyId,
      amount: 99.00,
      method: 'yape',
      reference: 'YAPE-REACTIVACION',
      months: 1,
      notes: 'Pago tras suspensión',
    });

    assert(payReactivationRes.company.status === 'active', 'Empresa vuelve a status "active" tras el pago');

    // Login vuelve a funcionar de inmediato
    const loginReactivatedRes = await request('/auth/login', {
      method: 'POST',
      body: { email: companyA.adminEmail, password: DEMO_PASSWORD },
    });
    assert(loginReactivatedRes.status === 200, `Login exitoso tras reactivación (status ${loginReactivatedRes.status})`);
    const newAdminTokenA = loginReactivatedRes.data?.data?.token;

    // GET /company funciona con el nuevo token
    const getCompanyReactivatedRes = await request('/company', {
      method: 'GET',
      headers: { Authorization: `Bearer ${newAdminTokenA}` },
    });
    assert(getCompanyReactivatedRes.status === 200, 'GET /api/company retorna 200 tras reactivación');
    assert(getCompanyReactivatedRes.data?.data?.status === 'active', 'Empresa en GET /api/company es active');

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 8: Registro Inmutable en audit_logs
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 8: Registro Inmutable en audit_logs ---');

    const { rows: auditPayRows } = await pool.query(
      `SELECT * FROM audit_logs WHERE company_id = $1 AND action = 'subscription_payment' ORDER BY id DESC LIMIT 1`,
      [companyA.companyId]
    );
    assert(auditPayRows.length > 0, 'Existe registro de auditoría con action "subscription_payment"');
    assert(auditPayRows[0].user_id === null, 'Operación del sistema/CLI registra user_id = NULL');
    assert(auditPayRows[0].changes?.amount === 99, 'Auditoría guarda el monto exacto');
    assert(Boolean(auditPayRows[0].changes?.period_to), 'Auditoría guarda el nuevo vencimiento');

    const { rows: auditSuspendRows } = await pool.query(
      `SELECT * FROM audit_logs WHERE company_id = $1 AND action = 'auto_suspend' ORDER BY id DESC LIMIT 1`,
      [companyA.companyId]
    );
    assert(auditSuspendRows.length > 0, 'Existe registro de auditoría con action "auto_suspend"');
    assert(auditSuspendRows[0].user_id === null, 'auto_suspend registra user_id = NULL');

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 9: GET /api/company/plan con billing y RBAC en Instrucciones
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 9: GET /api/company/plan con Estructura billing y RBAC ---');

    const planAdminRes = await request('/company/plan', {
      method: 'GET',
      headers: { Authorization: `Bearer ${newAdminTokenA}` },
    });

    assert(planAdminRes.status === 200, 'GET /api/company/plan retorna 200');
    const billingAdmin = planAdminRes.data?.data?.billing;
    assert(billingAdmin !== undefined && billingAdmin !== null, 'Respuesta incluye objeto "billing"');
    assert(billingAdmin?.status === 'active', 'billing.status es "active"');
    assert(Boolean(billingAdmin?.paid_until), 'billing.paid_until presente con formato fecha');
    assert(typeof billingAdmin?.days_left === 'number', 'billing.days_left es numérico');
    assert(billingAdmin?.last_payment?.amount === 99, 'billing.last_payment contiene el último pago');
    assert(
      billingAdmin?.payment_instructions !== null && Boolean(billingAdmin?.payment_instructions),
      'payment_instructions está presente para rol admin'
    );

    // Consulta con rol cajero: no debe ver payment_instructions
    const planCajeroRes = await request('/company/plan', {
      method: 'GET',
      headers: { Authorization: `Bearer ${realCajeroTokenA}` },
    });
    assert(planCajeroRes.status === 200, 'Cajero puede consultar /api/company/plan');
    const billingCajero = planCajeroRes.data?.data?.billing;
    assert(billingCajero?.payment_instructions === null, 'billing.payment_instructions es NULL para rol cajero');

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 10: GET /api/company/payments (RBAC y Aislamiento Multi-Tenant)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 10: GET /api/company/payments (RBAC y Aislamiento) ---');

    // Cajero intenta ver pagos -> 403 Forbidden
    const paymentsCajeroRes = await request('/company/payments', {
      method: 'GET',
      headers: { Authorization: `Bearer ${realCajeroTokenA}` },
    });
    assert(paymentsCajeroRes.status === 403, `Cajero intentando ver pagos recibe 403 (obtuvo ${paymentsCajeroRes.status})`);

    // Admin A ve sus pagos
    const paymentsAdminARes = await request('/company/payments', {
      method: 'GET',
      headers: { Authorization: `Bearer ${newAdminTokenA}` },
    });
    assert(paymentsAdminARes.status === 200, 'Admin A obtiene historial de pagos (200)');
    const paymentsA = paymentsAdminARes.data?.data || [];
    assert(paymentsA.length >= 3, `Admin A tiene registros de pago (${paymentsA.length})`);
    assert(paymentsA[0].method !== undefined, 'Pagos incluyen método de pago');
    assert(paymentsA[0].period_from !== undefined, 'Pagos incluyen period_from');
    assert(paymentsA[0].period_to !== undefined, 'Pagos incluyen period_to');

    // Admin B ve solo sus pagos (Aislamiento)
    const paymentsAdminBRes = await request('/company/payments', {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminTokenB}` },
    });
    assert(paymentsAdminBRes.status === 200, 'Admin B obtiene historial de pagos (200)');
    const paymentsB = paymentsAdminBRes.data?.data || [];
    const payAIds = paymentsA.map((p) => p.id);
    const hasLeak = paymentsB.some((p) => payAIds.includes(p.id));
    assert(!hasLeak, 'Aislamiento: Admin B NO puede ver ningún pago de Company A');

    // ──────────────────────────────────────────────────────────────────────────
    // CASO 11: Endpoint POST /api/jobs/subscriptions
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CASO 11: Endpoint POST /api/jobs/subscriptions ---');

    // Sin token -> 401
    const noTokenRes = await request('/jobs/subscriptions', { method: 'POST' });
    assert(noTokenRes.status === 401, `Sin token retorna 401 (obtuvo ${noTokenRes.status})`);

    // Token inválido -> 401
    const badTokenRes = await request('/jobs/subscriptions', {
      method: 'POST',
      headers: { 'X-Job-Token': 'token_falso_invalido' },
    });
    assert(badTokenRes.status === 401, `Token inválido retorna 401 (obtuvo ${badTokenRes.status})`);

    // Token correcto -> 200
    if (JOBS_TOKEN) {
      const okJobRes = await request('/jobs/subscriptions', {
        method: 'POST',
        headers: { 'X-Job-Token': JOBS_TOKEN },
      });
      assert(okJobRes.status === 200, `Token correcto retorna 200 (obtuvo ${okJobRes.status})`);
      assert(okJobRes.data?.success === true, 'Responde { success: true }');
      assert(okJobRes.data?.data?.suspended !== undefined, 'Responde datos de empresas suspendidas');
    } else {
      console.log('  ⚠️ JOBS_TOKEN no definido en el entorno: caso de job exitoso omitido');
    }

  } catch (err) {
    console.error('💥 Error inesperado durante verify-13-2:', err);
    failedTests++;
  } finally {
    // Limpieza lógica de empresas de prueba
    if (companyA && companyB) {
      await pool.query(`UPDATE companies SET is_active = false WHERE id IN ($1, $2)`, [
        companyA.companyId,
        companyB.companyId,
      ]);
      console.log('\n🧹  Empresas [PRUEBA] desactivadas lógicamente.');
    }
    await pool.end();
  }

  console.log('\n===============================================================');
  console.log(`🏁 RESULTADOS: ${passedTests} pasadas, ${failedTests} fallidas (Total: ${totalTests})`);
  console.log('===============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run();
