import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';
import { markOverdueNotPickedUp } from '../../src/modules/workorders/workorders.service.js';

const API_URL = `http://localhost:${process.env.PORT ?? 4000}/api`;
const JWT_SECRET = process.env.JWT_SECRET || 'MySecretK3yForJWTs1234567890!@#%^&*()_+|';
const JOBS_TOKEN = process.env.JOBS_TOKEN;

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASA] ${message}`);
  } else {
    failedTests++;
    console.error(`  [FALLA] ${message} `);
  }
}

function makeToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
}

async function request(path, options = {}) {
  const url = `${API_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const config = {
    method: options.method || 'GET',
    headers,
  };
  if (options.body) {
    config.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, config);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // respuesta no JSON
  }
  return { status: res.status, data };
}

async function run() {
  console.log('\n===============================================================');
  console.log('🧪  INICIANDO SUITE VERIFY-12-5: JOB NO RECOGIDO Y ALERTAS (RF-17)');
  console.log('===============================================================\n');

  let companyA = null;
  let companyB = null;

  try {
    // ─── 0. Verificación de integridad de Taller Principal (Regla 8) ───────────
    const { rows: [realBefore] } = await pool.query(
      `SELECT COUNT(*)::int as count FROM work_orders WHERE company_id = 1`
    );
    console.log(`🛡️  Taller Principal (id: 1) - OTs iniciales: ${realBefore.count}`);

    // Preparar empresas de prueba
    const seeded = await seedTestCompany();
    companyA = seeded.companyA;
    companyB = seeded.companyB;

    // Configurar not_picked_up_days: Empresa A = 15 días, Empresa B = 30 días
    await pool.query('UPDATE companies SET not_picked_up_days = 15 WHERE id = $1', [companyA.companyId]);
    await pool.query('UPDATE companies SET not_picked_up_days = 30 WHERE id = $1', [companyB.companyId]);

    // Crear usuarios de prueba (cajero y mecánico)
    const { rows: [cajeroA] } = await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active)
       VALUES ($1, 'Cajero A 12.5', $2, 'hash', 'cajero', true)
       ON CONFLICT (email) DO UPDATE SET role = 'cajero', is_active = true
       RETURNING id, email, role`,
      [companyA.companyId, `cajero.125.${companyA.companyId}@mototrack.local`]
    );

    const tokenAdminA = makeToken({ id: companyA.adminId, email: companyA.adminEmail, role: 'admin', company_id: companyA.companyId });
    const tokenCajeroA = makeToken({ id: cajeroA.id, email: cajeroA.email, role: 'cajero', company_id: companyA.companyId });
    const tokenMecanicoA = makeToken({ id: companyA.mechanicId, email: companyA.mechanicEmail, role: 'mecanico', company_id: companyA.companyId });
    const tokenAdminB = makeToken({ id: companyB.adminId, email: companyB.adminEmail, role: 'admin', company_id: companyB.companyId });

    // Poner en 'entregado' órdenes previas de empresas de prueba para aislar esta corrida
    await pool.query('UPDATE work_orders SET status = \'entregado\' WHERE company_id IN ($1, $2)', [companyA.companyId, companyB.companyId]);

    // ─── Crear vehículos y OTs de prueba ──────────────────────────────────────
    const ts = Date.now();
    const placaA1 = `TEST-${ts % 10000}A`;
    const placaA2 = `TEST-${ts % 10000}B`;
    const placaA3 = `TEST-${ts % 10000}C`;
    const placaB1 = `TEST-${ts % 10000}D`;

    const { rows: [vehA1] } = await pool.query(
      `INSERT INTO vehicles (company_id, placa, brand, model, customer_name, customer_phone)
       VALUES ($1, $2, 'Honda', 'CG125', 'Carlos Cliente A1', '999111222') RETURNING id`,
      [companyA.companyId, placaA1]
    );

    const { rows: [vehA2] } = await pool.query(
      `INSERT INTO vehicles (company_id, placa, brand, model, customer_name, customer_phone)
       VALUES ($1, $2, 'Yamaha', 'YBR125', 'Maria Cliente A2', '999333444') RETURNING id`,
      [companyA.companyId, placaA2]
    );

    const { rows: [vehA3] } = await pool.query(
      `INSERT INTO vehicles (company_id, placa, brand, model, customer_name, customer_phone)
       VALUES ($1, $2, 'Bajaj', 'Pulsar 200', 'Juan Cliente A3', '999555666') RETURNING id`,
      [companyA.companyId, placaA3]
    );

    const { rows: [vehB1] } = await pool.query(
      `INSERT INTO vehicles (company_id, placa, brand, model, customer_name, customer_phone)
       VALUES ($1, $2, 'Suzuki', 'GN125', 'Pedro Cliente B1', '999777888') RETURNING id`,
      [companyB.companyId, placaB1]
    );

    // woA1: Empresa A (plazo 15), terminada hace 20 días -> DEBE pasar a 'no_recogido'
    const { rows: [woA1] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, status, entry_mileage, terminado_at)
       VALUES ($1, $2, 'terminado', 1000, NOW() - INTERVAL '20 days') RETURNING *`,
      [companyA.companyId, vehA1.id]
    );

    // woA2: Empresa A (plazo 15), terminada hace 10 días -> NO debe cambiar
    const { rows: [woA2] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, status, entry_mileage, terminado_at)
       VALUES ($1, $2, 'terminado', 2000, NOW() - INTERVAL '10 days') RETURNING *`,
      [companyA.companyId, vehA2.id]
    );

    // woA3: Empresa A (plazo 15), terminada hace 14 días -> due_soon (a 1 día de vencer)
    const { rows: [woA3] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, status, entry_mileage, terminado_at)
       VALUES ($1, $2, 'terminado', 3000, NOW() - INTERVAL '14 days') RETURNING *`,
      [companyA.companyId, vehA3.id]
    );

    // woB1: Empresa B (plazo 30), terminada hace 20 días -> NO debe cambiar (20 < 30)
    const { rows: [woB1] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, status, entry_mileage, terminado_at)
       VALUES ($1, $2, 'terminado', 5000, NOW() - INTERVAL '20 days') RETURNING *`,
      [companyB.companyId, vehB1.id]
    );

    // ─── 1. Ejecución de markOverdueNotPickedUp() ─────────────────────────────
    console.log('--- Caso 1: markOverdueNotPickedUp() y umbrales por empresa ---');
    const resJob1 = await markOverdueNotPickedUp();

    assert(resJob1.updated >= 1, `Job actualiza al menos 1 orden (actualizadas: ${resJob1.updated})`);
    assert(resJob1.by_company[String(companyA.companyId)] >= 1, 'Empresa A registra actualización');
    assert(!resJob1.by_company[String(companyB.companyId)], 'Empresa B con plazo 30 días no sufre actualizaciones');

    // Verificar en BD
    const { rows: [checkA1] } = await pool.query('SELECT status FROM work_orders WHERE id = $1', [woA1.id]);
    assert(checkA1.status === 'no_recogido', 'OT A1 terminada hace 20 días con plazo 15 pasó a no_recogido');

    const { rows: [checkA2] } = await pool.query('SELECT status FROM work_orders WHERE id = $1', [woA2.id]);
    assert(checkA2.status === 'terminado', 'OT A2 terminada hace 10 días se mantiene en terminado');

    const { rows: [checkB1] } = await pool.query('SELECT status FROM work_orders WHERE id = $1', [woB1.id]);
    assert(checkB1.status === 'terminado', 'OT B1 terminada hace 20 días con plazo 30 se mantiene en terminado');

    // Verificar audit_logs y notifications para woA1
    const { rows: auditRows } = await pool.query(
      `SELECT * FROM audit_logs WHERE company_id = $1 AND entity = 'work_order' AND entity_id = $2`,
      [companyA.companyId, woA1.id]
    );
    assert(auditRows.length === 1, 'Genera exactamente 1 fila en audit_logs para la OT afectada');
    assert(auditRows[0].action === 'auto_not_picked_up', 'Acción de auditoría es auto_not_picked_up');
    assert(auditRows[0].user_id === null, 'user_id es NULL (operación de sistema)');
    assert(auditRows[0].changes?.status?.old === 'terminado' && auditRows[0].changes?.status?.new === 'no_recogido', 'changes refleja terminado -> no_recogido');
    assert(auditRows[0].changes?.dias_esperando >= 20, 'changes registra dias_esperando >= 20');

    const { rows: notifRows } = await pool.query(
      `SELECT * FROM notifications WHERE company_id = $1 AND work_order_id = $2`,
      [companyA.companyId, woA1.id]
    );
    assert(notifRows.length === 1, 'Genera exactamente 1 fila en notifications');
    assert(notifRows[0].message.includes(placaA1) && notifRows[0].message.includes('días terminada sin ser recogida'), 'Mensaje de notificación contiene placa y días esperando');

    // ─── 2. Idempotencia en segunda ejecución ────────────────────────────────
    console.log('\n--- Caso 2: Idempotencia en segunda ejecución consecutiva ---');
    const resJob2 = await markOverdueNotPickedUp();
    assert(resJob2.updated === 0, 'Segunda ejecución retorna updated = 0 (idempotente)');

    const { rows: notifRows2 } = await pool.query(
      `SELECT count(*)::int as count FROM notifications WHERE company_id = $1 AND work_order_id = $2`,
      [companyA.companyId, woA1.id]
    );
    assert(notifRows2[0].count === 1, 'No duplica notificaciones tras ejecución repetida');

    // ─── 3. Empresa inactiva no se procesa ────────────────────────────────────
    console.log('\n--- Caso 3: Empresa inactiva no es procesada por el job ---');
    // Creamos OT en empresa B y desactivamos empresa B temporalmente
    const { rows: [woBInact] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, status, entry_mileage, terminado_at)
       VALUES ($1, $2, 'terminado', 1000, NOW() - INTERVAL '40 days') RETURNING id`,
      [companyB.companyId, vehB1.id]
    );
    await pool.query('UPDATE companies SET is_active = false WHERE id = $1', [companyB.companyId]);

    const resJobInact = await markOverdueNotPickedUp();
    const { rows: [checkBInact] } = await pool.query('SELECT status FROM work_orders WHERE id = $1', [woBInact.id]);
    assert(checkBInact.status === 'terminado', 'OT de empresa inactiva NO cambia a no_recogido');

    // Reactivar empresa B
    await pool.query('UPDATE companies SET is_active = true WHERE id = $1', [companyB.companyId]);

    // ─── 4. Flujo: no_recogido -> entregado ──────────────────────────────────
    console.log('\n--- Caso 4: Transición no_recogido -> entregado ---');
    const resDeliver = await request(`/workorders/${woA1.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { status: 'entregado' },
    });
    assert(resDeliver.status === 200, 'Entrega desde no_recogido responde HTTP 200');
    assert(resDeliver.data?.data?.status === 'entregado', 'Estado actualizado a entregado exitosamente');

    // ─── 5. Endpoint del Job POST /api/jobs/not-picked-up ────────────────────
    console.log('\n--- Caso 5: Endpoint POST /api/jobs/not-picked-up (Cloud Scheduler) ---');
    if (!JOBS_TOKEN) {
      console.log('  ⚠️ JOBS_TOKEN no definido: casos del endpoint omitidos');
    } else {
      // 5a. Sin header X-Job-Token -> 401
      const resJobNoToken = await request('/jobs/not-picked-up', { method: 'POST' });
      assert(resJobNoToken.status === 401, 'Petición sin token responde 401 Unauthorized');

      // 5b. Con token incorrecto -> 401
      const resJobBadToken = await request('/jobs/not-picked-up', {
        method: 'POST',
        headers: { 'X-Job-Token': 'token_falso_invalido_123' },
      });
      assert(resJobBadToken.status === 401, 'Petición con token incorrecto responde 401 Unauthorized');

      // 5c. Con token correcto -> 200
      const resJobOk = await request('/jobs/not-picked-up', {
        method: 'POST',
        headers: { 'X-Job-Token': JOBS_TOKEN },
      });
      assert(resJobOk.status === 200, 'Petición con token correcto responde 200 OK');
      assert(resJobOk.data?.success === true, 'Respuesta incluye success: true');
      assert(typeof resJobOk.data?.data?.updated === 'number', 'Respuesta incluye objeto con updated');
    }

    // ─── 6. GET /api/workorders/pickup-alerts y RBAC ─────────────────────────
    console.log('\n--- Caso 6: GET /api/workorders/pickup-alerts y RBAC ---');
    // 6a. Mecánico -> 403 Forbidden
    const resAlertsMec = await request('/workorders/pickup-alerts', {
      headers: { Authorization: `Bearer ${tokenMecanicoA}` },
    });
    assert(resAlertsMec.status === 403, 'Rol mecánico recibe 403 Forbidden al consultar pickup-alerts');

    // 6b. Admin -> 200 OK
    const resAlertsAdmin = await request('/workorders/pickup-alerts', {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    assert(resAlertsAdmin.status === 200, 'Rol admin accede con 200 OK a pickup-alerts');

    // 6c. Cajero -> 200 OK
    const resAlertsCaj = await request('/workorders/pickup-alerts', {
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
    });
    assert(resAlertsCaj.status === 200, 'Rol cajero accede con 200 OK a pickup-alerts');

    // Crear una nueva OT en no_recogido para verificar campos del endpoint
    const { rows: [woA4_norec] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, status, entry_mileage, terminado_at)
       VALUES ($1, $2, 'no_recogido', 1500, NOW() - INTERVAL '18 days') RETURNING *`,
      [companyA.companyId, vehA1.id]
    );

    const resAlertsData = await request('/workorders/pickup-alerts', {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const { not_picked_up, due_soon } = resAlertsData.data?.data || {};

    assert(Array.isArray(not_picked_up) && not_picked_up.some(o => o.id === woA4_norec.id), 'not_picked_up incluye la OT en estado no_recogido');
    assert(Array.isArray(due_soon) && due_soon.some(o => o.id === woA3.id), 'due_soon incluye la OT que vence en 1 día (terminada hace 14 de 15)');
    assert(!due_soon.some(o => o.id === woA2.id), 'due_soon NO incluye la OT que vence en 5 días (terminada hace 10 de 15)');

    const itemSample = not_picked_up.find(o => o.id === woA4_norec.id);
    assert(itemSample?.placa === placaA1, 'Elemento de alerta incluye placa del vehículo');
    assert(Boolean(itemSample?.cliente), 'Elemento de alerta incluye nombre del cliente');
    assert(Boolean(itemSample?.telefono), 'Elemento de alerta incluye teléfono del cliente');
    assert(itemSample?.dias_esperando >= 18, 'Elemento de alerta incluye días esperando');

    // ─── 7. Verificación de integridad de Taller Principal (Regla 8) ───────────
    console.log('\n--- Verificación Final: Integridad de Taller Principal ---');
    const { rows: [realAfter] } = await pool.query(
      `SELECT COUNT(*)::int as count FROM work_orders WHERE company_id = 1`
    );
    assert(realBefore.count === realAfter.count, `Taller Principal intacto (OTs antes: ${realBefore.count}, después: ${realAfter.count})`);

  } catch (err) {
    console.error('💥 Error inesperado durante la ejecución:', err);
    failedTests++;
  } finally {
    // Limpieza lógica estricta (Regla 8)
    if (companyA?.companyId && companyB?.companyId) {
      await pool.query(
        `UPDATE work_orders SET status = 'entregado' WHERE company_id IN ($1, $2)`,
        [companyA.companyId, companyB.companyId]
      );
      await pool.query(
        `UPDATE companies SET is_active = false WHERE id IN ($1, $2)`,
        [companyA.companyId, companyB.companyId]
      );
    }
    console.log('\n🧹  Limpieza completada: Empresas y órdenes de prueba desactivadas (Regla 8).');
    await pool.end();
  }

  console.log('\n===============================================================');
  console.log(`📊  RESULTADOS: ${passedTests}/${totalTests} pruebas pasaron.`);
  if (failedTests > 0) {
    console.log(`❌  ${failedTests} prueba(s) fallaron.`);
    console.log('===============================================================\n');
    process.exit(1);
  } else {
    console.log('✅  TODAS LAS PRUEBAS DE LA TAREA 12.5 PASARON CON ÉXITO.');
    console.log('===============================================================\n');
    process.exit(0);
  }
}

run();
