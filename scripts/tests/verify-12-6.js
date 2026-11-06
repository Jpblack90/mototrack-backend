import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';
import { normalizePhonePE } from '../../src/shared/utils/phonePE.js';
import { markOverdueNotPickedUp } from '../../src/modules/workorders/workorders.service.js';

const API_URL = `http://localhost:${process.env.PORT ?? 4000}/api`;
const JWT_SECRET = process.env.JWT_SECRET || 'MySecretK3yForJWTs1234567890!@#%^&*()_+|';

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
    console.error(`  [FALLA] ${message}`);
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
  console.log('🧪  INICIANDO SUITE VERIFY-12-6: AVISOS POR WHATSAPP FASE 1 (RF-15)');
  console.log('===============================================================\n');

  let companyA = null;
  let companyB = null;

  try {
    // ─── 0. Verificación de integridad de Taller Principal (Regla 8) ───────────
    const { rows: [realBefore] } = await pool.query(
      `SELECT COUNT(*)::int as count FROM work_orders WHERE company_id = 1`
    );
    console.log(`🛡️  Taller Principal (id: 1) - OTs iniciales: ${realBefore.count}`);

    // ─── 1. Pruebas Unitarias de normalizePhonePE ─────────────────────────────
    console.log('\n--- Caso 1: Helper normalizePhonePE() ---');
    assert(normalizePhonePE('987 654 321') === '51987654321', '"987 654 321" normaliza a "51987654321"');
    assert(normalizePhonePE('+51 987-654-321') === '51987654321', '"+51 987-654-321" normaliza a "51987654321"');
    assert(normalizePhonePE('01 4567890') === null, '"01 4567890" (número fijo) retorna null');
    assert(normalizePhonePE('12345') === null, '"12345" (longitud inválida) retorna null');
    assert(normalizePhonePE(null) === null, 'null retorna null');
    assert(normalizePhonePE('') === null, 'string vacío retorna null');

    // Preparar empresas de prueba
    console.log('\n🏢  Verificando/creando empresas de prueba ([PRUEBA] Taller A y B)...');
    const seeded = await seedTestCompany();
    companyA = seeded.companyA;
    companyB = seeded.companyB;

    // Asegurar not_picked_up_days para Empresa A
    await pool.query('UPDATE companies SET not_picked_up_days = 15 WHERE id = $1', [companyA.companyId]);

    // Crear usuarios de prueba (cajero y mecánico)
    const { rows: [cajeroA] } = await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active)
       VALUES ($1, 'Cajero A 12.6', $2, 'hash', 'cajero', true)
       ON CONFLICT (email) DO UPDATE SET role = 'cajero', is_active = true
       RETURNING id, email, role`,
      [companyA.companyId, `cajero.126.${companyA.companyId}@mototrack.local`]
    );

    const tokenAdminA = makeToken({ id: companyA.adminId, email: companyA.adminEmail, role: 'admin', company_id: companyA.companyId });
    const tokenCajeroA = makeToken({ id: cajeroA.id, email: cajeroA.email, role: 'cajero', company_id: companyA.companyId });
    const tokenMecanicoA = makeToken({ id: companyA.mechanicId, email: companyA.mechanicEmail, role: 'mecanico', company_id: companyA.companyId });
    const tokenAdminB = makeToken({ id: companyB.adminId, email: companyB.adminEmail, role: 'admin', company_id: companyB.companyId });

    // Aislar órdenes previas de prueba marcándolas como entregadas
    await pool.query('UPDATE work_orders SET status = \'entregado\' WHERE company_id IN ($1, $2)', [companyA.companyId, companyB.companyId]);
    await pool.query('UPDATE notifications SET status = \'skipped\' WHERE company_id IN ($1, $2)', [companyA.companyId, companyB.companyId]);

    const ts = Date.now().toString().slice(-4);
    const placaA1 = `WA1-${ts}`;
    const placaA2 = `WA2-${ts}`;
    const placaA3 = `WA3-${ts}`;

    // ─── 2. OT con consentimiento y celular válido vs sin consentimiento ──────
    console.log('\n--- Caso 2: Registro de OT y consentimiento de WhatsApp ---');

    // 2a. Con consentimiento y celular válido -> aviso 'recibido' pendiente
    const resOT1 = await request('/workorders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        placa: placaA1,
        brand: 'Honda',
        model: 'Wave 110',
        customer_name: 'Roberto Valdivia',
        customer_phone: '987 654 321',
        entry_mileage: 4500,
        checklist_notes: 'Sin rayones visibles',
        whatsapp_opt_in: true,
      },
    });
    assert(resOT1.status === 201, 'OT 1 creada con 201 Created');
    const ot1Id = resOT1.data?.data?.id;

    // Verificar en BD que el vehículo guardó consentimiento y celular normalizado
    const { rows: [veh1Check] } = await pool.query(
      'SELECT whatsapp_opt_in, whatsapp_opt_in_at, customer_phone FROM vehicles WHERE placa = $1 AND company_id = $2',
      [placaA1, companyA.companyId]
    );
    assert(veh1Check.whatsapp_opt_in === true, 'Vehículo 1 tiene whatsapp_opt_in = true en BD');
    assert(veh1Check.whatsapp_opt_in_at !== null, 'Vehículo 1 registra fecha whatsapp_opt_in_at');
    assert(veh1Check.customer_phone === '51987654321', 'Vehículo 1 guarda teléfono normalizado 51987654321');

    // Verificar notificación 'recibido' creada
    const resNotifOT1 = await request(`/workorders/${ot1Id}/notifications`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    assert(resNotifOT1.status === 200, 'GET /workorders/:id/notifications responde 200');
    const notifsOT1 = resNotifOT1.data?.data || [];
    const notifRecibido = notifsOT1.find(n => n.event === 'recibido');
    assert(Boolean(notifRecibido), 'Se generó aviso con event = "recibido"');
    assert(notifRecibido?.status === 'pending', 'El aviso "recibido" está en status "pending"');
    assert(notifRecibido?.message.includes('Roberto Valdivia'), 'Mensaje incluye nombre del cliente');
    assert(notifRecibido?.message.includes(placaA1), 'Mensaje incluye placa de la moto');
    assert(notifRecibido?.message.includes('Taller A') || notifRecibido?.message.includes('PRUEBA'), 'Mensaje incluye nombre del taller');

    // 2b. Sin consentimiento -> no genera aviso pendiente
    const resOT2 = await request('/workorders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        placa: placaA2,
        brand: 'Yamaha',
        model: 'FZ 150',
        customer_name: 'Laura Sanchez',
        customer_phone: '999888777',
        entry_mileage: 12000,
        whatsapp_opt_in: false,
      },
    });
    assert(resOT2.status === 201, 'OT 2 creada con 201 Created');
    const ot2Id = resOT2.data?.data?.id;

    const resNotifOT2 = await request(`/workorders/${ot2Id}/notifications`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const notifsOT2 = resNotifOT2.data?.data || [];
    const pendingOT2 = notifsOT2.filter(n => n.status === 'pending');
    assert(pendingOT2.length === 0, 'OT 2 sin consentimiento NO genera avisos pendientes');

    // ─── 3. Consentimiento con celular inválido responde 422 ───────────────────
    console.log('\n--- Caso 3: Consentimiento con celular inválido ---');
    const resOTBadPhone = await request('/workorders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        placa: placaA3,
        customer_name: 'Cliente Fijo',
        customer_phone: '01 4567890', // Teléfono fijo limeño no es celular válido
        entry_mileage: 3000,
        whatsapp_opt_in: true,
      },
    });
    assert(resOTBadPhone.status === 422, 'Responde 422 al enviar consentimiento con celular inválido');
    assert(
      resOTBadPhone.data?.error?.message === 'Ingresa un celular válido de 9 dígitos para enviar avisos por WhatsApp',
      'Mensaje de error 422 exacto sobre celular válido'
    );

    // ─── 4. Transiciones de estado y generación de avisos ─────────────────────
    console.log('\n--- Caso 4: Transiciones de estado y avisos WhatsApp ---');

    // Transición a 'diagnostico' (estado sin plantilla) -> NO genera aviso
    const resDiag = await request(`/workorders/${ot1Id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { status: 'diagnostico' },
    });
    assert(resDiag.status === 200, 'OT 1 avanzada a diagnostico (200)');

    const resNotifsDiag = await request(`/workorders/${ot1Id}/notifications`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const diagNotif = resNotifsDiag.data?.data?.find(n => n.event === 'diagnostico');
    assert(!diagNotif, 'Estado "diagnostico" (sin plantilla) NO genera ningún aviso');

    // Transición a 'en_reparacion'
    await request(`/workorders/${ot1Id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { status: 'en_reparacion' },
    });

    // Transición a 'terminado' -> genera aviso 'terminado' con nombre del taller y placa
    const resTerm = await request(`/workorders/${ot1Id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { status: 'terminado' },
    });
    assert(resTerm.status === 200, 'OT 1 avanzada a terminado (200)');

    const resNotifsTerm = await request(`/workorders/${ot1Id}/notifications`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const notifTerm = resNotifsTerm.data?.data?.find(n => n.event === 'terminado');
    assert(Boolean(notifTerm), 'Se generó aviso con event = "terminado"');
    assert(notifTerm?.status === 'pending', 'Aviso "terminado" está en status "pending"');
    assert(notifTerm?.message.includes('ya está lista para recoger'), 'Mensaje incluye "ya está lista para recoger"');
    assert(notifTerm?.message.includes(placaA1), 'Mensaje incluye la placa');

    // ─── 5. El Job de no recogido genera su aviso ─────────────────────────────
    console.log('\n--- Caso 5: Job no recogido genera aviso con plantilla ---');
    // Creamos OT en empresa A terminada hace 20 días con consentimiento WhatsApp
    const placaOverdue = `OV1-${ts}`;
    const { rows: [vehOverdue] } = await pool.query(
      `INSERT INTO vehicles (company_id, placa, customer_name, customer_phone, whatsapp_opt_in, whatsapp_opt_in_at)
       VALUES ($1, $2, 'Daniel Alarcón', '51912345678', true, NOW())
       RETURNING id`,
      [companyA.companyId, placaOverdue]
    );

    const { rows: [woOverdue] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, status, entry_mileage, terminado_at)
       VALUES ($1, $2, 'terminado', 8000, NOW() - INTERVAL '20 days')
       RETURNING id`,
      [companyA.companyId, vehOverdue.id]
    );

    // Ejecutar job
    const resJob = await markOverdueNotPickedUp();
    assert(resJob.updated >= 1, `Job procesa órdenes atrasadas (actualizadas: ${resJob.updated})`);

    const { rows: notifsJob } = await pool.query(
      `SELECT * FROM notifications WHERE work_order_id = $1 AND event = 'no_recogido'`,
      [woOverdue.id]
    );
    assert(notifsJob.length === 1, 'Job generó exactamente 1 aviso con event = "no_recogido"');
    assert(notifsJob[0]?.status === 'pending', 'Aviso de no_recogido generado por el job está en status "pending"');
    assert(notifsJob[0]?.message.includes('Daniel Alarcón'), 'Aviso incluye nombre del cliente');
    assert(notifsJob[0]?.message.includes(placaOverdue), 'Aviso incluye placa');
    assert(notifsJob[0]?.message.includes('días'), 'Aviso incluye conteo de días');

    // ─── 6. Endpoint GET /api/notifications/:id/whatsapp-link ─────────────────
    console.log('\n--- Caso 6: Endpoint whatsapp-link y codificación segura ---');
    const noticeToLink = notifsJob[0];
    const resLink = await request(`/notifications/${noticeToLink.id}/whatsapp-link`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    assert(resLink.status === 200, 'GET /notifications/:id/whatsapp-link responde 200');
    assert(resLink.data?.data?.url?.startsWith('https://wa.me/51912345678'), 'URL inicia con https://wa.me/51912345678');
    assert(!resLink.data?.data?.url?.includes(' '), 'URL está debidamente codificada y no tiene espacios crudos');
    assert(resLink.data?.data?.phone === '51912345678', 'Devuelve el teléfono normalizado 51912345678');
    assert(typeof resLink.data?.data?.message === 'string', 'Devuelve el texto del mensaje');

    // Si el cliente no tiene consentimiento -> 422
    // Creamos notificación artificial para una orden sin consentimiento
    const { rows: [notifNoOpt] } = await pool.query(
      `INSERT INTO notifications (company_id, work_order_id, message, channel, status, event)
       VALUES ($1, $2, 'Aviso sin opt-in', 'whatsapp', 'pending', 'recibido') RETURNING id`,
      [companyA.companyId, ot2Id]
    );
    const resLinkNoOpt = await request(`/notifications/${notifNoOpt.id}/whatsapp-link`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    assert(resLinkNoOpt.status === 422, 'Consulta de link sin consentimiento del cliente responde 422');

    // ─── 7. opened es idempotente y skip funciona ─────────────────────────────
    console.log('\n--- Caso 7: Ciclo de vida: opened idempotente y skip ---');
    const resOpen1 = await request(`/notifications/${noticeToLink.id}/opened`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
    });
    assert(resOpen1.status === 200, 'PATCH /notifications/:id/opened responde 200');
    assert(resOpen1.data?.data?.status === 'opened', 'Aviso pasa a status "opened"');
    assert(Boolean(resOpen1.data?.data?.opened_at), 'Registra fecha opened_at');
    assert(resOpen1.data?.data?.opened_by === cajeroA.id, 'Registra opened_by = cajeroA.id');

    const firstOpenedAt = resOpen1.data?.data?.opened_at;

    // Segunda llamada idempotente
    const resOpen2 = await request(`/notifications/${noticeToLink.id}/opened`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    assert(resOpen2.status === 200, 'Segunda llamada responde 200 (idempotente)');
    assert(resOpen2.data?.data?.status === 'opened', 'Permanece en status "opened"');
    assert(resOpen2.data?.data?.opened_at === firstOpenedAt, 'No altera la fecha opened_at original');
    assert(resOpen2.data?.data?.opened_by === cajeroA.id, 'No altera el opened_by original');

    // Prueba de skip en otra notificación
    const resSkip = await request(`/notifications/${notifRecibido.id}/skip`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    assert(resSkip.status === 200, 'PATCH /notifications/:id/skip responde 200');
    assert(resSkip.data?.data?.status === 'skipped', 'Aviso pasa a status "skipped"');

    // ─── 8. RBAC y permisos en endpoints de notificaciones ────────────────────
    console.log('\n--- Caso 8: RBAC (Mecánico -> 403 Forbidden) ---');
    const resMecPending = await request('/notifications/pending', {
      headers: { Authorization: `Bearer ${tokenMecanicoA}` },
    });
    assert(resMecPending.status === 403, 'Mecánico recibe 403 en GET /notifications/pending');

    const resMecLink = await request(`/notifications/${noticeToLink.id}/whatsapp-link`, {
      headers: { Authorization: `Bearer ${tokenMecanicoA}` },
    });
    assert(resMecLink.status === 403, 'Mecánico recibe 403 en GET /notifications/:id/whatsapp-link');

    const resMecOpen = await request(`/notifications/${noticeToLink.id}/opened`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMecanicoA}` },
    });
    assert(resMecOpen.status === 403, 'Mecánico recibe 403 en PATCH /notifications/:id/opened');

    const resMecOTNotifs = await request(`/workorders/${ot1Id}/notifications`, {
      headers: { Authorization: `Bearer ${tokenMecanicoA}` },
    });
    assert(resMecOTNotifs.status === 403, 'Mecánico recibe 403 en GET /workorders/:id/notifications');

    // ─── 9. Verificación de integridad de Taller Principal (Regla 8) ───────────
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
        `UPDATE notifications SET status = 'skipped' WHERE company_id IN ($1, $2)`,
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
    console.log('✅  TODAS LAS PRUEBAS DE LA TAREA 12.6 PASARON CON ÉXITO.');
    console.log('===============================================================\n');
    process.exit(0);
  }
}

run();
