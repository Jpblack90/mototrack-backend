// =============================================================================
// scripts/seed-demo-company.js
// Crea un taller DEMO ficticio con 60 días de operación simulada para
// presentaciones (Feria Tecnológica). Todos los nombres, placas, RUC y
// teléfonos son inventados; no corresponden a personas ni empresas reales.
//
// Usa los servicios reales del backend (ventas, comprobantes, OT), así que
// stock, IGV, pagos y correlativos quedan igual que en el uso normal; luego
// solo se ajustan las fechas (created_at) para repartirlas en 60 días.
//
// Uso:
//   DEMO_COMPANY_PASSWORD='***' node scripts/seed-demo-company.js
//   DEMO_COMPANY_PASSWORD='***' node scripts/seed-demo-company.js --reset
//
//   --reset  borra los datos operativos de ESTE taller (ventas, comprobantes,
//            OT, vehículos, kits, productos) y los vuelve a generar.
//            No toca ninguna otra empresa.
// =============================================================================

import 'dotenv/config';
import bcrypt from 'bcrypt';
import pool from '../src/config/database.js';
import { normalizeModel } from '../src/shared/utils/modelNormalizer.js';
import { createKit, createSale } from '../src/modules/sales/sales.service.js';
import { createInvoice } from '../src/modules/invoicing/invoicing.service.js';
import {
  createWorkOrder,
  updateStatus,
  approveAdditionalWork,
} from '../src/modules/workorders/workorders.service.js';

// ─── Configuración del taller ficticio ────────────────────────────────────────

const DAYS = 60;
const IGV_RATE = 0.18;
const RESET = process.argv.includes('--reset');
const PASSWORD = process.env.DEMO_COMPANY_PASSWORD || process.env.DEMO_USERS_PASSWORD;

const COMPANY = {
  ruc: '20999999957', // rango de pruebas 209999999xx (ficticio)
  razon_social: 'MotoServicios Huaytapallana S.A.C.',
  nombre_comercial: 'MotoServicios Huaytapallana',
  direccion: 'Huancayo, Junín',
  email: 'contacto@huaytapallana.local',
};

const USERS = [
  { key: 'admin',      name: 'Rosa Huamán Quispe',   email: 'admin@huaytapallana.local',   role: 'admin' },
  { key: 'cajero',     name: 'Lucía Ccanto Rojas',   email: 'caja@huaytapallana.local',    role: 'cajero' },
  { key: 'almacenero', name: 'Edwin Poma Ríos',      email: 'almacen@huaytapallana.local', role: 'almacenero' },
  { key: 'mec1',       name: 'Julio Cárdenas Mayta', email: 'julio@huaytapallana.local',   role: 'mecanico' },
  { key: 'mec2',       name: 'Raúl Inga Soto',       email: 'raul@huaytapallana.local',    role: 'mecanico' },
];

// sku, nombre, marca, categoría, modelos compatibles, costo, venta, stock final, stock mínimo, peso (rotación)
const PRODUCTS = [
  ['ACE-2050-MT', 'Aceite 20W-50 4T 1 L', 'Motul', 'Lubricantes', [], 22, 32, 28, 10, 10],
  ['ACE-1040-CA', 'Aceite 10W-40 semisintético 1 L', 'Castrol', 'Lubricantes', [], 30, 42, 15, 8, 6],
  ['ACE-2050-RP', 'Aceite 20W-50 4T 1 L', 'Repsol', 'Lubricantes', [], 20, 29, 22, 10, 7],
  ['FIL-ACE-PUL', 'Filtro de aceite Pulsar 180/NS200', 'Bajaj', 'Filtros', ['Bajaj Pulsar 180', 'Bajaj Pulsar NS200'], 9, 16, 18, 6, 6],
  ['FIL-ACE-HON', 'Filtro de aceite CG/XR 150', 'Honda', 'Filtros', ['Honda CG125', 'Honda XR150L', 'Honda CB190R'], 8, 15, 4, 6, 6],
  ['FIL-AIR-PUL', 'Filtro de aire Pulsar 180', 'Bajaj', 'Filtros', ['Bajaj Pulsar 180'], 18, 30, 7, 4, 3],
  ['FIL-AIR-XR',  'Filtro de aire XR150L', 'Honda', 'Filtros', ['Honda XR150L'], 20, 35, 3, 4, 3],
  ['BUJ-CR7HSA',  'Bujía CR7HSA', 'NGK', 'Motor', ['Honda CG125', 'Honda XR150L', 'Yamaha YBR125', 'TVS Apache RTR 160'], 7, 14, 40, 15, 8],
  ['BUJ-DR8ES',   'Bujía DR8ES', 'NGK', 'Motor', ['Bajaj Pulsar 180', 'Bajaj Boxer 150'], 8, 15, 25, 10, 6],
  ['PAS-DEL-PUL', 'Pastillas de freno delanteras Pulsar', 'Bajaj', 'Frenos', ['Bajaj Pulsar 180', 'Bajaj Pulsar NS200'], 22, 38, 12, 5, 4],
  ['PAS-DEL-HON', 'Pastillas de freno delanteras XR/CB', 'Honda', 'Frenos', ['Honda XR150L', 'Honda CB190R'], 20, 35, 9, 5, 4],
  ['ZAP-POS-BOX', 'Zapatas de freno posterior Boxer/CT100', 'Bajaj', 'Frenos', ['Bajaj Boxer 150', 'Bajaj CT100'], 15, 28, 2, 4, 3],
  ['LIQ-DOT4-250', 'Líquido de frenos DOT 4 250 ml', 'Bosch', 'Frenos', [], 12, 20, 14, 5, 3],
  ['KIT-ARR-PUL', 'Kit de arrastre Pulsar 180', 'Riffel', 'Transmisión', ['Bajaj Pulsar 180'], 95, 150, 5, 3, 2],
  ['KIT-ARR-XR',  'Kit de arrastre XR150L', 'Riffel', 'Transmisión', ['Honda XR150L'], 105, 165, 4, 3, 2],
  ['CAD-428H-118', 'Cadena 428H x 118 eslabones', 'DID', 'Transmisión', ['Honda CG125', 'Bajaj Boxer 150', 'Yamaha YBR125'], 38, 60, 8, 4, 2],
  ['EMB-DIS-PUL', 'Discos de embrague Pulsar 180', 'Bajaj', 'Transmisión', ['Bajaj Pulsar 180'], 55, 90, 0, 2, 1],
  ['CAB-EMB-UNI', 'Cable de embrague universal', 'Genérico', 'Transmisión', [], 8, 15, 20, 6, 3],
  ['CAB-ACE-UNI', 'Cable de acelerador universal', 'Genérico', 'Transmisión', [], 7, 14, 16, 6, 2],
  ['BAT-YTX7L',   'Batería YTX7L-BS 12 V', 'Yuasa', 'Sistema eléctrico', ['Honda XR150L', 'Bajaj Pulsar 180', 'Yamaha FZ 2.0'], 120, 185, 6, 3, 2],
  ['BAT-12N5-3B', 'Batería 12N5-3B 12 V', 'Yuasa', 'Sistema eléctrico', ['Bajaj Boxer 150', 'Honda CG125'], 75, 115, 5, 3, 2],
  ['FOC-H4-HAL',  'Foco halógeno H4 12 V 35/35 W', 'Osram', 'Iluminación', [], 9, 18, 30, 10, 4],
  ['FOC-H4-LED',  'Foco LED H4', 'Genérico', 'Iluminación', [], 25, 45, 10, 4, 2],
  ['DIR-LED-PAR', 'Direccionales LED (par)', 'Genérico', 'Iluminación', [], 18, 35, 12, 4, 2],
  ['LLA-275-18',  'Llanta 2.75-18', 'Maxxis', 'Llantas y cámaras', [], 95, 145, 6, 3, 2],
  ['LLA-300-17',  'Llanta 3.00-17', 'Maxxis', 'Llantas y cámaras', [], 105, 160, 4, 3, 1],
  ['LLA-9090-18', 'Llanta 90/90-18', 'IRC', 'Llantas y cámaras', [], 110, 170, 3, 2, 1],
  ['CAM-ARO-18',  'Cámara aro 18', 'Kenda', 'Llantas y cámaras', [], 14, 25, 18, 6, 4],
  ['CAM-ARO-17',  'Cámara aro 17', 'Kenda', 'Llantas y cámaras', [], 13, 24, 12, 6, 3],
  ['AMO-POS-BOX', 'Amortiguadores posteriores Boxer (par)', 'Bajaj', 'Suspensión', ['Bajaj Boxer 150'], 110, 170, 3, 2, 1],
  ['RET-BAR-PUL', 'Retenes de barra Pulsar (par)', 'Bajaj', 'Suspensión', ['Bajaj Pulsar 180'], 15, 28, 9, 4, 2],
  ['ACE-HOR-200', 'Aceite de horquilla SAE 10 200 ml', 'Motul', 'Lubricantes', [], 14, 24, 8, 4, 1],
  ['EMP-CUL-150', 'Empaquetadura de culata 150 cc', 'Genérico', 'Motor', ['Honda CG125', 'Bajaj Boxer 150'], 12, 25, 7, 3, 1],
  ['PIS-STD-150', 'Kit pistón STD 150 cc', 'Genérico', 'Motor', ['Honda CG125', 'Bajaj Boxer 150'], 65, 110, 4, 2, 1],
  ['CAR-PZ27',    'Carburador PZ27', 'Genérico', 'Motor', [], 70, 120, 3, 2, 1],
  ['ESP-RET-PAR', 'Espejos retrovisores (par)', 'Genérico', 'Carrocería', [], 15, 30, 14, 4, 2],
  ['PUN-MAN-PAR', 'Puños de manubrio (par)', 'Genérico', 'Accesorios', [], 8, 18, 20, 5, 2],
  ['CAS-INT-M',   'Casco integral talla M', 'Genérico', 'Accesorios', [], 140, 220, 5, 2, 1],
  ['LUB-CAD-400', 'Lubricante de cadena spray 400 ml', 'Motul', 'Lubricantes', [], 22, 36, 9, 4, 3],
  ['REF-MOTO-1L', 'Refrigerante para moto 1 L', 'Genérico', 'Lubricantes', [], 12, 22, 10, 4, 1],
];

const KITS = [
  { name: 'Kit mantenimiento 150 cc', description: 'Aceite 20W-50, filtro de aceite y bujía', kit_price: 55, items: [['ACE-2050-MT', 1], ['FIL-ACE-HON', 1], ['BUJ-CR7HSA', 1]] },
  { name: 'Kit mantenimiento Pulsar', description: 'Aceite 10W-40, filtro de aceite y bujía', kit_price: 65, items: [['ACE-1040-CA', 1], ['FIL-ACE-PUL', 1], ['BUJ-DR8ES', 1]] },
  { name: 'Kit frenos Pulsar', description: 'Pastillas delanteras y líquido DOT 4', kit_price: 52, items: [['PAS-DEL-PUL', 1], ['LIQ-DOT4-250', 1]] },
];

const MOTOS = [
  ['Honda', 'XR150L'], ['Honda', 'CG125'], ['Honda', 'CB190R'], ['Bajaj', 'Pulsar 180'],
  ['Bajaj', 'Pulsar NS200'], ['Bajaj', 'Boxer 150'], ['Bajaj', 'CT100'], ['Yamaha', 'YBR125'],
  ['Yamaha', 'FZ 2.0'], ['TVS', 'Apache RTR 160'],
];
const FIRST = ['Carlos', 'María', 'José', 'Ana', 'Luis', 'Rosa', 'Jorge', 'Elena', 'Miguel', 'Carmen', 'Pedro', 'Sonia',
  'Víctor', 'Ruth', 'Wilber', 'Yesenia', 'Fredy', 'Maribel', 'Hugo', 'Nancy', 'Elmer', 'Gladys', 'Percy', 'Lidia'];
const LAST = ['Quispe', 'Huamán', 'Rojas', 'Mendoza', 'Ccanto', 'Poma', 'Rivera', 'Cárdenas', 'Inga', 'Mayta', 'Soto',
  'Camposano', 'Orihuela', 'Vílchez', 'Baquerizo', 'Hinostroza', 'Palacios', 'Tovar', 'Zárate', 'Lazo'];
const EMPRESAS = [
  { name: 'Transportes Rápidos del Centro S.A.C.', ruc: '20999999965' },
  { name: 'Delivery Mantaro E.I.R.L.', ruc: '20999999973' },
];
const CHECKLIST = [
  'Tanque 1/2, espejos completos, sin golpes visibles.',
  'Tanque 1/4, falta espejo izquierdo, rayón en tanque.',
  'Tanque lleno, llaves y documentos entregados.',
  'Tanque 3/4, direccional trasera rota.',
  'Tanque 1/2, cliente reporta ruido en la cadena.',
];
const DIAGNOSES = [
  ['Mantenimiento general: cambio de aceite, filtro y bujía.', 40, ['K:Kit mantenimiento 150 cc']],
  ['Mantenimiento general Pulsar: aceite, filtro, bujía y limpieza de carburador.', 50, ['K:Kit mantenimiento Pulsar']],
  ['Pastillas delanteras gastadas, se reemplazan y se purga el sistema.', 35, ['K:Kit frenos Pulsar']],
  ['Kit de arrastre con desgaste severo, se reemplaza completo.', 60, ['KIT-ARR-PUL']],
  ['Kit de arrastre con desgaste severo, se reemplaza completo.', 60, ['KIT-ARR-XR']],
  ['Batería no retiene carga, se reemplaza y se revisa el regulador.', 30, ['BAT-YTX7L']],
  ['Embrague patina en 3.ª y 4.ª marcha, se cambian discos.', 120, ['EMB-DIS-PUL', 'ACE-1040-CA']],
  ['Compresión baja, se rectifica cilindro y se cambia kit de pistón.', 220, ['PIS-STD-150', 'EMP-CUL-150', 'ACE-2050-RP']],
  ['Zapatas posteriores al límite, se reemplazan y se regula el freno.', 25, ['ZAP-POS-BOX']],
  ['Llanta posterior lisa y cámara parchada, se reemplazan.', 20, ['LLA-275-18', 'CAM-ARO-18']],
  ['Amortiguadores posteriores sin rebote, se reemplazan.', 45, ['AMO-POS-BOX']],
  ['Carburador con fuga, se reemplaza y se calibra ralentí.', 50, ['CAR-PZ27']],
];

// ─── Utilidades ───────────────────────────────────────────────────────────────

let seed = 20261127;
function rand() { // mulberry32: mismos datos en cada ejecución
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const round2 = (n) => +n.toFixed(2);
function weightedPick(items, weightOf) {
  const total = items.reduce((a, it) => a + weightOf(it), 0);
  let r = rand() * total;
  for (const it of items) { r -= weightOf(it); if (r <= 0) return it; }
  return items[items.length - 1];
}

const NOW = new Date();
const LIMA_OFFSET_H = 5; // America/Lima = UTC-5 (sin horario de verano)

/** Fecha en hora de Lima: daysAgo días atrás a las h:m (sin recortar). */
function limaTimeRaw(daysAgo, h, m) {
  const limaNow = new Date(NOW.getTime() - LIMA_OFFSET_H * 3600e3);
  return new Date(Date.UTC(limaNow.getUTCFullYear(), limaNow.getUTCMonth(), limaNow.getUTCDate() - daysAgo, h + LIMA_OFFSET_H, m));
}
/** Igual que limaTimeRaw, pero nunca en el futuro. */
function limaTime(daysAgo, h, m) {
  const d = limaTimeRaw(daysAgo, h, m);
  const limit = new Date(NOW.getTime() - 5 * 60e3);
  return d > limit ? new Date(limit.getTime() - int(5, 90) * 60e3) : d;
}
const addMin = (d, min) => new Date(d.getTime() + min * 60e3);
function limaWeekday(daysAgo) {
  const limaNow = new Date(NOW.getTime() - LIMA_OFFSET_H * 3600e3);
  return new Date(Date.UTC(limaNow.getUTCFullYear(), limaNow.getUTCMonth(), limaNow.getUTCDate() - daysAgo)).getUTCDay();
}

// ─── Empresa y usuarios ───────────────────────────────────────────────────────

async function ensureCompany() {
  const { rows } = await pool.query('SELECT id FROM companies WHERE ruc = $1', [COMPANY.ruc]);
  if (rows[0]) {
    if (!RESET) {
      console.log(`ℹ️  El taller demo ya existe (empresa #${rows[0].id}). Usa --reset para regenerar sus datos.`);
      return null;
    }
    await resetCompanyData(rows[0].id);
    return rows[0].id;
  }
  const { rows: ins } = await pool.query(
    `INSERT INTO companies (ruc, razon_social, nombre_comercial, direccion, email, igv_rate,
                            approval_threshold, not_picked_up_days, status, is_active, plan_id,
                            terms_accepted_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 100, 15, 'active', true,
             (SELECT id FROM plans WHERE code = 'mototrack' LIMIT 1), $7, $7)
     RETURNING id`,
    [COMPANY.ruc, COMPANY.razon_social, COMPANY.nombre_comercial, COMPANY.direccion, COMPANY.email,
      IGV_RATE, new Date(NOW.getTime() - (DAYS + 10) * 86400e3)]
  );
  console.log(`✅ Empresa creada: ${COMPANY.nombre_comercial} (#${ins[0].id})`);
  return ins[0].id;
}

async function resetCompanyData(cid) {
  console.log(`♻️  --reset: borrando datos operativos de la empresa #${cid}…`);
  const q = (sql) => pool.query(sql, [cid]);
  await q('DELETE FROM credit_notes WHERE company_id = $1');
  await q('DELETE FROM invoices WHERE company_id = $1');
  await q('DELETE FROM invoice_series WHERE company_id = $1');
  await q('DELETE FROM sale_payments WHERE company_id = $1');
  await q('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)');
  await q('DELETE FROM sales WHERE company_id = $1');
  await q('DELETE FROM notifications WHERE company_id = $1');
  await q('DELETE FROM work_orders WHERE company_id = $1');
  await q('DELETE FROM vehicles WHERE company_id = $1');
  await q('DELETE FROM kit_items WHERE kit_id IN (SELECT id FROM kits WHERE company_id = $1)');
  await q('DELETE FROM kits WHERE company_id = $1');
  await q('DELETE FROM products WHERE company_id = $1');
}

async function ensureUsers(cid) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ids = {};
  for (const u of USERS) {
    const { rows } = await pool.query('SELECT id, company_id FROM users WHERE email = $1', [u.email]);
    if (rows[0] && rows[0].company_id !== cid) {
      throw new Error(`El correo ${u.email} ya pertenece a otra empresa (#${rows[0].company_id}).`);
    }
    if (rows[0]) {
      await pool.query(
        `UPDATE users SET name = $1, role = $2, password_hash = $3, is_active = true, must_change_password = false
         WHERE id = $4`, [u.name, u.role, hash, rows[0].id]);
      ids[u.key] = rows[0].id;
    } else {
      const { rows: ins } = await pool.query(
        `INSERT INTO users (company_id, name, email, password_hash, role, is_active, must_change_password, created_at)
         VALUES ($1, $2, $3, $4, $5, true, false, $6) RETURNING id`,
        [cid, u.name, u.email, hash, u.role, new Date(NOW.getTime() - (DAYS + 8) * 86400e3)]);
      ids[u.key] = ins[0].id;
    }
  }
  console.log(`✅ Usuarios: ${USERS.map((u) => u.email).join(', ')}`);
  return ids;
}

// ─── Catálogo ─────────────────────────────────────────────────────────────────

async function seedCatalog(cid) {
  const bySku = {};
  const created = new Date(NOW.getTime() - (DAYS + 5) * 86400e3);
  for (const [sku, name, brand, category, models, cost, sale, , minStock, weight] of PRODUCTS) {
    const byAi = rand() < 0.35; // registrados escaneando la foto con IA
    const { rows } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, compatible_models, cost_price, sale_price,
                             stock, min_stock, registration_method, ai_confidence, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 500, $9, $10, $11, true, $12, $12)
       RETURNING id`,
      [cid, sku, name, brand, category, models.map(normalizeModel), cost, sale, minStock,
        byAi ? 'ia' : 'manual', byAi ? int(82, 98) : null, created]
    );
    bySku[sku] = { id: rows[0].id, sku, price: sale, weight };
  }
  const kits = {};
  for (const k of KITS) {
    const kit = await createKit({
      name: k.name,
      description: k.description,
      kit_price: k.kit_price,
      items: k.items.map(([sku, quantity]) => ({ product_id: bySku[sku].id, quantity })),
    }, cid);
    await pool.query('UPDATE kits SET created_at = $1 WHERE id = $2', [created, kit.id]);
    kits[k.name] = { id: kit.id, price: k.kit_price };
  }
  console.log(`✅ Catálogo: ${PRODUCTS.length} productos y ${KITS.length} kits`);
  return { bySku, kits };
}

// ─── Clientes y vehículos ─────────────────────────────────────────────────────

function makeCustomers(n) {
  const placas = new Set();
  const out = [];
  while (out.length < n) {
    const placa = `${int(1000, 9999)}-${String.fromCharCode(65 + int(0, 25))}${String.fromCharCode(65 + int(0, 25))}`;
    if (placas.has(placa)) continue;
    placas.add(placa);
    const [brand, model] = pick(MOTOS);
    out.push({
      name: `${pick(FIRST)} ${pick(LAST)} ${pick(LAST)}`,
      phone: `9${int(10000000, 99999999)}`,
      placa, brand, model,
      mileage: int(3000, 45000),
    });
  }
  return out;
}

// ─── Órdenes de trabajo ───────────────────────────────────────────────────────

// [estado final, días atrás de ingreso]
const OT_PLAN = [
  ...Array.from({ length: 20 }, (_, i) => ['entregado', 58 - i * 2.7]),
  ['no_recogido', 27], ['no_recogido', 22],
  ['terminado', 3], ['terminado', 2],
  ['en_reparacion', 2], ['en_reparacion', 1],
  ['pendiente_aprobacion', 1],
  ['diagnostico', 1], ['diagnostico', 0],
  ['recibido', 0],
];

async function seedWorkOrders(cid, userIds, customers) {
  const mechanics = [userIds.mec1, userIds.mec2];
  const deliverySales = [];
  let i = 0;
  for (const [finalStatus, daysAgoRaw] of OT_PLAN) {
    const daysAgo = Math.round(daysAgoRaw);
    const c = customers[i % customers.length];
    const unassigned = finalStatus === 'recibido';
    const mechanicId = unassigned ? null : mechanics[i % 2];
    const tIn = limaTime(daysAgo, int(8, 11), int(0, 59));
    const [diagText, laborBase, parts] = finalStatus === 'pendiente_aprobacion'
      ? DIAGNOSES[7]
      : pick(finalStatus === 'en_reparacion' ? DIAGNOSES.filter((d) => d[1] <= 100) : DIAGNOSES);
    const labor = laborBase;

    const wo = await createWorkOrder({
      placa: c.placa, brand: c.brand, model: c.model,
      customer_name: c.name, customer_phone: c.phone,
      entry_mileage: c.mileage + int(0, 1500),
      checklist_notes: pick(CHECKLIST),
      whatsapp_opt_in: false,
      mechanic_id: mechanicId,
    }, cid);
    const id = wo.id;
    let tLast = tIn;
    let tTerm = null;

    if (finalStatus !== 'recibido') {
      await updateStatus(id, 'diagnostico', {}, cid);
      tLast = addMin(tIn, int(30, 120));
    }
    if (!['recibido', 'diagnostico'].includes(finalStatus)) {
      const res = await updateStatus(id, 'en_reparacion', { diagnosis_notes: diagText, additional_cost: labor }, cid);
      tLast = addMin(tLast, int(20, 90));
      if (res.status === 'pendiente_aprobacion' && finalStatus !== 'pendiente_aprobacion') {
        await approveAdditionalWork(id, cid);
        tLast = addMin(tLast, int(30, 180));
      }
    } else if (finalStatus === 'diagnostico') {
      await pool.query('UPDATE work_orders SET diagnosis_notes = $1 WHERE id = $2', ['En revisión: ' + diagText.split(':')[0].toLowerCase() + '.', id]);
    }
    if (['terminado', 'entregado', 'no_recogido'].includes(finalStatus)) {
      await updateStatus(id, 'terminado', {}, cid);
      tTerm = finalStatus === 'terminado'
        ? limaTime(daysAgo - 1 >= 0 ? daysAgo - 1 : 0, int(15, 18), int(0, 59))
        : addMin(tIn, int(4, 30) * 60);
      tLast = tTerm;
    }
    if (finalStatus === 'no_recogido') {
      await updateStatus(id, 'no_recogido', {}, cid);
      tLast = addMin(tTerm, 16 * 1440 + int(0, 300));
    }
    if (finalStatus === 'entregado') {
      await updateStatus(id, 'entregado', {}, cid);
      tLast = addMin(tTerm, int(60, 1440));
      deliverySales.push({ time: addMin(tLast, -5), customer: c.name, work_order_id: id, parts });
    }

    await pool.query(
      `UPDATE work_orders SET created_at = $1, updated_at = $2, terminado_at = $3 WHERE id = $4`,
      [tIn, tLast, tTerm, id]
    );
    await pool.query('UPDATE vehicles SET created_at = LEAST(created_at, $1) WHERE id = $2', [tIn, wo.vehicle.id]);
    await pool.query('UPDATE notifications SET created_at = $1 WHERE work_order_id = $2', [tLast, id]);
    i++;
  }
  console.log(`✅ Órdenes de trabajo: ${OT_PLAN.length} (${deliverySales.length} entregadas con venta)`);
  return deliverySales;
}

// ─── Ventas y comprobantes ────────────────────────────────────────────────────

function posSalesPlan(catalog, customers) {
  const products = Object.values(catalog.bySku);
  const kits = Object.values(catalog.kits);
  const plan = [];
  for (let d = DAYS - 1; d >= 0; d--) {
    const wd = limaWeekday(d);
    const n = d === 0 ? 5 : wd === 0 ? int(0, 1) : wd === 6 ? int(2, 4) : int(1, 2);
    for (let k = 0; k < n; k++) {
      // Hoy: solo las ventas cuya hora ya pasó (si se corre a las 11:00, hay ventas de 9:00 a 11:00)
      const time = limaTimeRaw(d, int(9, 19), int(0, 59));
      if (time > new Date(NOW.getTime() - 5 * 60e3)) continue;
      const items = [];
      if (rand() < 0.12) {
        items.push({ kit_id: pick(kits).id, quantity: 1 });
      } else {
        const lines = rand() < 0.6 ? 1 : rand() < 0.8 ? 2 : 3;
        const used = new Set();
        for (let l = 0; l < lines; l++) {
          const p = weightedPick(products, (x) => x.weight);
          if (used.has(p.id)) continue;
          used.add(p.id);
          items.push({ product_id: p.id, quantity: p.sku.startsWith('ACE-') && rand() < 0.3 ? 2 : 1 });
        }
      }
      plan.push({
        time,
        customer: rand() < 0.4 ? pick(customers).name : null,
        items,
      });
    }
  }
  return plan;
}

function priceOf(catalog, item) {
  if (item.kit_id) return Object.values(catalog.kits).find((k) => k.id === item.kit_id).price;
  return Object.values(catalog.bySku).find((p) => p.id === item.product_id).price;
}

function buildPayments(total) {
  const r = rand();
  if (r < 0.48) {
    const options = [total, Math.ceil(total / 10) * 10, Math.ceil(total / 50) * 50, Math.ceil(total / 100) * 100];
    const received = pick(options);
    return [{ method: 'efectivo', amount: total, cash_received: received }];
  }
  if (r < 0.78) return [{ method: 'yape', amount: total, reference: String(int(100000, 999999)) }];
  if (r < 0.86) return [{ method: 'plin', amount: total, reference: String(int(100000, 999999)) }];
  if (r < 0.96 || total < 40) return [{ method: 'tarjeta', amount: total, reference: `****${int(1000, 9999)}` }];
  const cash = round2(Math.floor(total / 2));
  return [
    { method: 'efectivo', amount: cash, cash_received: cash },
    { method: 'yape', amount: round2(total - cash), reference: String(int(100000, 999999)) },
  ];
}

async function seedSales(cid, catalog, customers, deliverySales) {
  const resolveParts = (parts) => parts.map((p) => (p.startsWith('K:')
    ? { kit_id: catalog.kits[p.slice(2)].id, quantity: 1 }
    : { product_id: catalog.bySku[p].id, quantity: 1 }));

  const all = [
    ...posSalesPlan(catalog, customers),
    ...deliverySales.map((s) => ({ time: s.time, customer: s.customer, work_order_id: s.work_order_id, items: resolveParts(s.parts) })),
  ].sort((a, b) => a.time - b.time);

  const pendingCount = 3; // las últimas ventas quedan "por facturar"
  let invoices = 0;
  let total = 0;
  for (let idx = 0; idx < all.length; idx++) {
    const s = all[idx];
    const subtotal = s.items.reduce((acc, it) => acc + round2(priceOf(catalog, it) * it.quantity), 0);
    const igv = round2(subtotal * IGV_RATE);
    const saleTotal = round2(subtotal + igv);
    const isFactura = rand() < 0.08;
    const empresa = isFactura ? pick(EMPRESAS) : null;

    const sale = await createSale({
      customer_name: empresa ? empresa.name : s.customer,
      work_order_id: s.work_order_id ?? null,
      payments: buildPayments(saleTotal),
      items: s.items,
    }, cid);
    total += Number(sale.total);
    await pool.query('UPDATE sales SET created_at = $1 WHERE id = $2', [s.time, sale.id]);
    await pool.query('UPDATE sale_payments SET created_at = $1 WHERE sale_id = $2', [s.time, sale.id]);

    if (idx < all.length - pendingCount) {
      const inv = await createInvoice({
        sale_id: sale.id,
        comprobante_type: isFactura ? 'factura' : 'boleta',
        customer_document_type: isFactura ? 'RUC' : null,
        customer_document_number: isFactura ? empresa.ruc : null,
      }, cid);
      const tInv = addMin(s.time, 1); // +1 min: mantiene el correlativo en orden cronológico
      await pool.query('UPDATE invoices SET created_at = $1, updated_at = $1 WHERE id = $2', [tInv, inv.id]);
      invoices++;
    }
  }
  console.log(`✅ Ventas: ${all.length} (S/ ${total.toFixed(2)} con IGV) · comprobantes emitidos: ${invoices} · por facturar: ${pendingCount}`);
}

async function setFinalStock(cid, catalog) {
  for (const [sku, , , , , , , finalStock] of PRODUCTS) {
    await pool.query('UPDATE products SET stock = $1 WHERE id = $2 AND company_id = $3', [finalStock, catalog.bySku[sku].id, cid]);
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE stock = 0) AS agotados,
            COUNT(*) FILTER (WHERE stock > 0 AND stock <= min_stock) AS bajos
     FROM products WHERE company_id = $1`, [cid]);
  console.log(`✅ Stock final ajustado (${rows[0].bajos} con stock bajo, ${rows[0].agotados} agotado)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!PASSWORD || PASSWORD.trim().length < 8) {
    console.error('❌ Define DEMO_COMPANY_PASSWORD (mínimo 8 caracteres) antes de ejecutar el script.');
    process.exit(1);
  }
  const cid = await ensureCompany();
  if (!cid) return;
  const userIds = await ensureUsers(cid);
  const catalog = await seedCatalog(cid);
  const customers = makeCustomers(34);
  const deliverySales = await seedWorkOrders(cid, userIds, customers);
  await seedSales(cid, catalog, customers, deliverySales);
  await setFinalStock(cid, catalog);
  console.log(`\n✨ Taller demo listo: ${COMPANY.nombre_comercial} (empresa #${cid}). Inicia sesión con ${USERS[0].email}.`);
}

main()
  .catch((err) => {
    console.error('❌ Error en seed-demo-company:', err.code ?? '', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
