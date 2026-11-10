// =============================================================================
// scripts/tests/verify-14-1.js
// Suite de verificación Tarea 14.1: Flujo del mecánico y restricciones RBAC de OT
//
// Reglas:
// 1. Mecánico solo puede avanzar OT asignadas a él (mechanic_id = user.id). Si no: 403 WORK_ORDER_NOT_ASSIGNED.
// 2. Mecánico solo puede pedir estados: 'diagnostico', 'en_reparacion', 'terminado'.
//    Si pide 'entregado' o 'no_recogido': 403 STATUS_NOT_ALLOWED_FOR_ROLE.
// 3. OT de otra empresa responde 404 WORK_ORDER_NOT_FOUND (aislamiento multi-tenant).
// 4. diagnostico -> en_reparacion con additional_cost > umbral -> pendiente_aprobacion (200).
// 5. Admin puede avanzar terminado -> entregado (200).
// 6. Limpieza y regla 8: desactivar empresas y usuarios [PRUEBA].
// =============================================================================

import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';

const API_URL = `http://localhost:${process.env.PORT ?? 4000}/api`;
const JWT_SECRET = process.env.JWT_SECRET || 'MySecretK3yForJWTs1234567890!@#%^&*()_+|';

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
  console.log('🧪  INICIANDO SUITE VERIFY-14-1: FLUJO Y RESTRICCIONES DEL MECÁNICO');
  console.log('===============================================================\n');

  let companyA = null;
  let companyB = null;
  const createdOtIds = [];

  try {
    // 1. Seed base
    const seed = await seedTestCompany();
    companyA = seed.companyA;
    companyB = seed.companyB;

    // Reactivar empresas y usuarios de prueba para la ejecución
    await pool.query('UPDATE companies SET is_active = true, approval_threshold = 100 WHERE id IN ($1, $2)', [
      companyA.companyId,
      companyB.companyId,
    ]);
    await pool.query('UPDATE users SET is_active = true WHERE company_id IN ($1, $2)', [
      companyA.companyId,
      companyB.companyId,
    ]);

    const tokenAdminA = makeToken({
      id: companyA.adminId,
      email: companyA.adminEmail,
      role: 'admin',
      company_id: companyA.companyId,
    });

    const tokenMechanicA = makeToken({
      id: companyA.mechanicId,
      email: companyA.mechanicEmail,
      role: 'mecanico',
      company_id: companyA.companyId,
    });

    // ─── CASO 1: Mecánico A avanza su OT: recibido → diagnostico → en_reparacion → terminado ─────
    console.log('\n--- Caso 1: Flujo feliz del mecánico sobre su OT asignada ---');
    const { rows: [ot1] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, $3, 10000, 'recibido')
       RETURNING id, status`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(ot1.id);

    // 1.1 recibido -> diagnostico
    const resDiag = await request(`/workorders/${ot1.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMechanicA}` },
      body: { status: 'diagnostico' },
    });
    assert(
      resDiag.status === 200 && resDiag.data?.data?.status === 'diagnostico',
      'Mecánico A avanza su OT recibido → diagnostico (200)'
    );

    // 1.2 diagnostico -> en_reparacion
    const resRep = await request(`/workorders/${ot1.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMechanicA}` },
      body: { status: 'en_reparacion', diagnosis_notes: 'Ajuste general de frenos y cadena' },
    });
    assert(
      resRep.status === 200 && resRep.data?.data?.status === 'en_reparacion',
      'Mecánico A avanza diagnostico → en_reparacion (200)'
    );

    // 1.3 en_reparacion -> terminado
    const resTerm = await request(`/workorders/${ot1.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMechanicA}` },
      body: { status: 'terminado' },
    });
    assert(
      resTerm.status === 200 && resTerm.data?.data?.status === 'terminado',
      'Mecánico A avanza en_reparacion → terminado (200)'
    );

    // ─── CASO 2: diagnostico → en_reparacion con additional_cost > umbral → pendiente_aprobacion ──
    console.log('\n--- Caso 2: additional_cost > umbral pasa a pendiente_aprobacion ---');
    const { rows: [ot2] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, $3, 15000, 'diagnostico')
       RETURNING id, status`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(ot2.id);

    const resOverCost = await request(`/workorders/${ot2.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMechanicA}` },
      body: {
        status: 'en_reparacion',
        additional_cost: 250, // > 100
        diagnosis_notes: 'Fallas mayores en cilindro y pistón',
      },
    });
    assert(
      resOverCost.status === 200 && resOverCost.data?.data?.status === 'pendiente_aprobacion',
      'diagnostico → en_reparacion con additional_cost mayor al umbral → queda pendiente_aprobacion (200)'
    );

    // ─── CASO 3: Mecánico A sobre OT sin asignar → 403 WORK_ORDER_NOT_ASSIGNED ───
    console.log('\n--- Caso 3: Mecánico sobre OT sin asignar ---');
    const { rows: [otUnassigned] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, NULL, 12000, 'recibido')
       RETURNING id, status`,
      [companyA.companyId, companyA.vehicleId]
    );
    createdOtIds.push(otUnassigned.id);

    const resUnassigned = await request(`/workorders/${otUnassigned.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMechanicA}` },
      body: { status: 'diagnostico' },
    });
    assert(
      resUnassigned.status === 403 &&
        resUnassigned.data?.error?.code === 'WORK_ORDER_NOT_ASSIGNED' &&
        resUnassigned.data?.error?.message === 'Esta orden no está asignada a ti.',
      'Mecánico A sobre OT sin asignar → 403 WORK_ORDER_NOT_ASSIGNED ("Esta orden no está asignada a ti.")',
      resUnassigned
    );

    // ─── CASO 4: Mecánico A pidiendo 'entregado' o 'no_recogido' → 403 STATUS_NOT_ALLOWED_FOR_ROLE ───
    console.log('\n--- Caso 4: Mecánico pidiendo entregado o no_recogido ---');
    const resDeliverMech = await request(`/workorders/${ot1.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMechanicA}` },
      body: { status: 'entregado' },
    });
    assert(
      resDeliverMech.status === 403 &&
        resDeliverMech.data?.error?.code === 'STATUS_NOT_ALLOWED_FOR_ROLE',
      'Mecánico A pidiendo "entregado" → 403 STATUS_NOT_ALLOWED_FOR_ROLE',
      resDeliverMech
    );

    const resNotPickedMech = await request(`/workorders/${ot1.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMechanicA}` },
      body: { status: 'no_recogido' },
    });
    assert(
      resNotPickedMech.status === 403 &&
        resNotPickedMech.data?.error?.code === 'STATUS_NOT_ALLOWED_FOR_ROLE',
      'Mecánico A pidiendo "no_recogido" → 403 STATUS_NOT_ALLOWED_FOR_ROLE',
      resNotPickedMech
    );

    // ─── CASO 5: Mecánico A sobre OT de Empresa B → 404 ───
    console.log('\n--- Caso 5: Mecánico sobre OT de otra empresa ---');
    const { rows: [otB] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, $3, 20000, 'recibido')
       RETURNING id, status`,
      [companyB.companyId, companyB.vehicleId, companyB.mechanicId]
    );
    createdOtIds.push(otB.id);

    const resCrossCompany = await request(`/workorders/${otB.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMechanicA}` },
      body: { status: 'diagnostico' },
    });
    assert(
      resCrossCompany.status === 404 && resCrossCompany.data?.error?.code === 'WORK_ORDER_NOT_FOUND',
      'Mecánico A sobre OT de Empresa B → 404 WORK_ORDER_NOT_FOUND',
      resCrossCompany
    );

    // ─── CASO 6: Admin A sigue pudiendo pasar terminado → entregado (200) ───
    console.log('\n--- Caso 6: Admin A entrega la orden terminada ---');
    const resDeliverAdmin = await request(`/workorders/${ot1.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { status: 'entregado' },
    });
    assert(
      resDeliverAdmin.status === 200 && resDeliverAdmin.data?.data?.status === 'entregado',
      'Admin A sigue pudiendo pasar terminado → entregado (200)',
      resDeliverAdmin
    );

  } catch (err) {
    console.error('❌  Error inesperado durante verify-14-1:', err);
    failedTests++;
  } finally {
    // Limpieza de OTs creadas
    if (createdOtIds.length > 0) {
      await pool.query('DELETE FROM work_orders WHERE id = ANY($1::int[])', [createdOtIds]);
    }

    // Regla 8: desactivar empresas y usuarios [PRUEBA]
    if (companyA && companyB) {
      await pool.query('UPDATE companies SET is_active = false WHERE id IN ($1, $2)', [
        companyA.companyId,
        companyB.companyId,
      ]);
      await pool.query('UPDATE users SET is_active = false, must_change_password = false WHERE company_id IN ($1, $2)', [
        companyA.companyId,
        companyB.companyId,
      ]);
    }

    console.log('\n===============================================================');
    console.log(`RESULTADOS: ${passedTests} pasaron, ${failedTests} fallaron (de ${totalTests} pruebas)`);
    console.log('===============================================================\n');

    await new Promise((r) => setTimeout(r, 50));
    process.exit(failedTests > 0 ? 1 : 0);
  }
}

run();
