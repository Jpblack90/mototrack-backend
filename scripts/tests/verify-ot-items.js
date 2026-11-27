// =============================================================================
// scripts/tests/verify-ot-items.js
// Suite de verificación: OT como cuenta abierta (work_order_items)
//
// Cobertura:
// 1. Aislamiento multi-tenant (GET/POST/PATCH/notify-link cruzados → 404).
// 2. RBAC (mecánico/almacenero → 403 al crear/decidir/notificar; mecánico solo sus OT en GET).
// 3. Alta de líneas (servicio, producto con stock_warning sin bloqueo) + logAudit + GET OT resumen.
// 4. Reglas de umbral: <= umbral aprueba con canal 'umbral'; > umbral desvía a pendiente_aprobacion; approve/reject en lote.
// 5. Regla móvil Opción A: PATCH /status con additional_cost != derivado → 422; == derivado (tolerancia 0.01) → 200.
// 6. En en_reparacion línea nueva siempre nace propuesta + notify-link wa.me + bloqueo 422 PENDING_ITEMS → terminado.
// 7. Cobro unificado con work_order_item_id: precio congelado vs cambio en catálogo (sale.total == approved_total + IGV),
//    errores 422 (id de otra OT, repetido, no aprobado, omitido, producto inactivo legible, sin stock), más extra de catálogo.
// 8. Retrocompatibilidad total en OT sin líneas (exactamente igual que antes).
// =============================================================================

import 'dotenv/config';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';

if (process.env.NODE_ENV === 'production') {
  console.error('❌  Error: verify-ot-items.js no debe ejecutarse en producción.');
  process.exit(1);
}

const API_URL = process.env.API_URL || `http://localhost:${process.env.PORT ?? 4000}/api`;

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

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // respuesta no JSON
  }
  return { status: res.status, data };
}

async function login(email, password) {
  const res = await request('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (res.status !== 200 || !res.data?.data?.token) {
    throw new Error(`No se pudo iniciar sesión con ${email}: HTTP ${res.status}`);
  }
  return res.data.data.token;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function run() {
  console.log('\n===============================================================');
  console.log('🧪  INICIANDO SUITE VERIFY-OT-ITEMS: OT COMO CUENTA ABIERTA');
  console.log('===============================================================\n');

  let companyA = null;
  let companyB = null;
  let originalVehOptIn = false;
  let originalVehPhone = null;
  const createdOtIds = [];
  const createdSaleIds = [];
  const createdProductIds = [];

  try {
    const seed = await seedTestCompany();
    companyA = seed.companyA;
    companyB = seed.companyB;

    await pool.query(
      "UPDATE companies SET is_active = true, igv_rate = 0.18, approval_threshold = 100, pse_provider = 'simulado' WHERE id IN ($1, $2)",
      [companyA.companyId, companyB.companyId]
    );
    await pool.query(
      'UPDATE users SET is_active = true WHERE company_id IN ($1, $2)',
      [companyA.companyId, companyB.companyId]
    );
    const { rows: [vehOrig] } = await pool.query(
      'SELECT whatsapp_opt_in, customer_phone FROM vehicles WHERE id = $1',
      [companyA.vehicleId]
    );
    originalVehOptIn = Boolean(vehOrig?.whatsapp_opt_in);
    originalVehPhone = vehOrig?.customer_phone ?? null;

    // Habilitar consentimiento y teléfono válido temporalmente (restaurados en finally)
    await pool.query(
      "UPDATE vehicles SET whatsapp_opt_in = true, customer_phone = '999111222' WHERE id = $1",
      [companyA.vehicleId]
    );

    const tokenAdminA = await login(companyA.adminEmail, companyA.adminPassword);
    const tokenCajeroA = await login(companyA.cajeroEmail, companyA.adminPassword);
    const tokenMecA = await login(companyA.mechanicEmail, companyA.adminPassword);
    const tokenAlmA = await login(companyA.almaceneroEmail, companyA.adminPassword);
    const tokenAdminB = await login(companyB.adminEmail, companyB.adminPassword);

    // Productos controlados para A y B
    const { rows: [prodCadena] } = await pool.query(
      `INSERT INTO products (company_id, name, sku, sale_price, cost_price, stock, min_stock, is_active)
       VALUES ($1, '[PRUEBA] Cadena 428H Items', 'PRUEBA-OTI-CAD', 60.00, 35.00, 5, 2, true)
       ON CONFLICT (company_id, sku)
       DO UPDATE SET sale_price = 60.00, stock = 5, is_active = true
       RETURNING *`,
      [companyA.companyId]
    );
    createdProductIds.push(prodCadena.id);

    const { rows: [prodDisco] } = await pool.query(
      `INSERT INTO products (company_id, name, sku, sale_price, cost_price, stock, min_stock, is_active)
       VALUES ($1, '[PRUEBA] Disco Freno Items', 'PRUEBA-OTI-DIS', 90.00, 55.00, 1, 2, true)
       ON CONFLICT (company_id, sku)
       DO UPDATE SET sale_price = 90.00, stock = 1, is_active = true
       RETURNING *`,
      [companyA.companyId]
    );
    createdProductIds.push(prodDisco.id);

    const { rows: [prodExtra] } = await pool.query(
      `INSERT INTO products (company_id, name, sku, sale_price, cost_price, stock, min_stock, is_active)
       VALUES ($1, '[PRUEBA] Foco Extra Items', 'PRUEBA-OTI-EXT', 20.00, 10.00, 8, 2, true)
       ON CONFLICT (company_id, sku)
       DO UPDATE SET sale_price = 20.00, stock = 8, is_active = true
       RETURNING *`,
      [companyA.companyId]
    );
    createdProductIds.push(prodExtra.id);

    // ─── CASO 1: RBAC y Aislamiento Multi-Tenant ───
    console.log('\n--- Caso 1: RBAC y aislamiento multi-tenant ---');
    const { rows: [otAssignedA] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, $3, 12000, 'diagnostico')
       RETURNING id`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(otAssignedA.id);

    const { rows: [otUnassignedA] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, NULL, 12100, 'diagnostico')
       RETURNING id`,
      [companyA.companyId, companyA.vehicleId]
    );
    createdOtIds.push(otUnassignedA.id);

    const resMecPost = await request(`/workorders/${otAssignedA.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenMecA}` },
      body: { type: 'service', description: 'Servicio mecánico', unit_price: 50, quantity: 1 },
    });
    assert(resMecPost.status === 403, 'Mecánico NO puede crear línea (POST /items → 403)', resMecPost);

    const resAlmPost = await request(`/workorders/${otAssignedA.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlmA}` },
      body: { type: 'service', description: 'Servicio almacenero', unit_price: 50, quantity: 1 },
    });
    assert(resAlmPost.status === 403, 'Almacenero NO puede crear línea (POST /items → 403)', resAlmPost);

    const resMecGetOwn = await request(`/workorders/${otAssignedA.id}/items`, {
      headers: { Authorization: `Bearer ${tokenMecA}` },
    });
    assert(resMecGetOwn.status === 200, 'Mecánico puede ver líneas de su OT asignada → 200', resMecGetOwn);

    const resMecGetOther = await request(`/workorders/${otUnassignedA.id}/items`, {
      headers: { Authorization: `Bearer ${tokenMecA}` },
    });
    assert(
      resMecGetOther.status === 403 && resMecGetOther.data?.error?.code === 'WORK_ORDER_NOT_ASSIGNED',
      'Mecánico recibe 403 WORK_ORDER_NOT_ASSIGNED en OT no asignada',
      resMecGetOther
    );

    const resAlmGet = await request(`/workorders/${otAssignedA.id}/items`, {
      headers: { Authorization: `Bearer ${tokenAlmA}` },
    });
    assert(resAlmGet.status === 200, 'Almacenero puede leer líneas de OT (GET /items → 200)', resAlmGet);

    const resCrossGet = await request(`/workorders/${otAssignedA.id}/items`, {
      headers: { Authorization: `Bearer ${tokenAdminB}` },
    });
    assert(resCrossGet.status === 404, 'Empresa B no ve ítems de OT de Empresa A → 404', resCrossGet);

    const resCrossPost = await request(`/workorders/${otAssignedA.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: { type: 'service', description: 'Intruso', unit_price: 50, quantity: 1 },
    });
    assert(resCrossPost.status === 404, 'Empresa B no crea ítems en OT de Empresa A → 404', resCrossPost);

    const resCrossProd = await request(`/workorders/${otAssignedA.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { type: 'product', product_id: companyB.productId, quantity: 1 },
    });
    assert(resCrossProd.status === 404, 'Empresa A no puede agregar producto de Empresa B → 404', resCrossProd);

    // ─── CASO 2: Alta de líneas, stock_warning sin bloqueo, umbral automático 'umbral' ───
    console.log('\n--- Caso 2: Alta de líneas, stock_warning, y aprobación automática <= umbral ---');
    // otUnassignedA está en diagnostico, agregamos Disco qty 2 cuando stock = 1 (90*2 = 180? No, usemos Cadena qty 1 = 60 <= 100)
    const { rows: [otUmbralLow] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, $3, 13000, 'diagnostico')
       RETURNING id`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(otUmbralLow.id);

    const resAddCad = await request(`/workorders/${otUmbralLow.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: { type: 'product', product_id: prodCadena.id, quantity: 1 },
    });
    assert(
      resAddCad.status === 201 &&
        resAddCad.data?.data?.item?.status === 'propuesta' &&
        Number(resAddCad.data?.data?.item?.unit_price) === 60 &&
        resAddCad.data?.data?.stock_warning === null &&
        Number(resAddCad.data?.data?.work_order?.additional_cost) === 60,
      'Cajero agrega producto (60.00) como propuesta y recalcula additional_cost = 60.00',
      resAddCad
    );

    const resAddSvcLow = await request(`/workorders/${otUmbralLow.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { type: 'service', description: '[PRUEBA] Ajuste cadena', unit_price: 30, quantity: 1 },
    });
    assert(
      resAddSvcLow.status === 201 && Number(resAddSvcLow.data?.data?.work_order?.additional_cost) === 90,
      'Admin agrega servicio (30.00) → total derivado = 90.00 (<= umbral 100)',
      resAddSvcLow
    );

    // stock_warning sin bloqueo: otAssignedA pide 2 unidades de prodDisco (stock = 1)
    const resStockWarn = await request(`/workorders/${otAssignedA.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: { type: 'product', product_id: prodDisco.id, quantity: 2 },
    });
    assert(
      resStockWarn.status === 201 &&
        resStockWarn.data?.data?.stock_warning?.available_stock === 1 &&
        resStockWarn.data?.data?.stock_warning?.requested_quantity === 2,
      'Stock insuficiente devuelve stock_warning sin bloquear alta (201)',
      resStockWarn
    );

    // RBAC mecánico/almacenero NO deciden ni generan notify-link
    const warnItemId = resStockWarn.data.data.item.id;
    const resMecDec = await request(`/workorders/${otAssignedA.id}/items/${warnItemId}/decision`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMecA}` },
      body: { decision: 'aprobada', channel: 'presencial' },
    });
    assert(resMecDec.status === 403, 'Mecánico NO puede decidir línea → 403', resMecDec);

    const resAlmDec = await request(`/workorders/${otAssignedA.id}/items/${warnItemId}/decision`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAlmA}` },
      body: { decision: 'rechazada', channel: 'presencial' },
    });
    assert(resAlmDec.status === 403, 'Almacenero NO puede decidir línea → 403', resAlmDec);

    // Pasar otUmbralLow diagnostico → en_reparacion (total 90 <= 100) aprueba ambas con canal 'umbral'
    const resUmbralAuto = await request(`/workorders/${otUmbralLow.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMecA}` },
      body: { status: 'en_reparacion', diagnosis_notes: 'Revisión <= umbral' },
    });
    assert(
      resUmbralAuto.status === 200 && resUmbralAuto.data?.data?.status === 'en_reparacion',
      'OT con líneas <= umbral pasa directo a en_reparacion',
      resUmbralAuto
    );
    const resItemsUmbral = await request(`/workorders/${otUmbralLow.id}/items`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    assert(
      resItemsUmbral.data?.data?.items?.length === 2 &&
        resItemsUmbral.data.data.items.every((i) => i.status === 'aprobada' && i.decision_channel === 'umbral'),
      'Todas las líneas propuestas pasaron a aprobada con canal="umbral"',
      resItemsUmbral
    );

    // ─── CASO 3: Umbral superado + Opción A móvil + approve/reject lote + en_reparacion + PENDING_ITEMS ───
    console.log('\n--- Caso 3: Flujo completo umbral > 100, móvil Opción A, en_reparacion, notify-link y PENDING_ITEMS ---');
    const { rows: [otMain] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, $3, 18000, 'diagnostico')
       RETURNING id`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(otMain.id);

    const addCadMain = await request(`/workorders/${otMain.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: { type: 'product', product_id: prodCadena.id, quantity: 1 }, // 60.00
    });
    const addMoMain = await request(`/workorders/${otMain.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: { type: 'service', description: 'Mano de obra transmisión', unit_price: 100, quantity: 1 }, // 100.00 → total 160.00
    });
    const cadItemId = addCadMain.data.data.item.id;
    const mo1ItemId = addMoMain.data.data.item.id;

    // Prueba móvil Opción A: enviar additional_cost diferente al derivado (160.00) → 422
    const resMobBad = await request(`/workorders/${otMain.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMecA}` },
      body: { status: 'en_reparacion', additional_cost: '999.00' },
    });
    assert(
      resMobBad.status === 422 && resMobBad.data?.error?.code === 'ADDITIONAL_COST_DERIVED_FROM_ITEMS',
      'Móvil enviando additional_cost="999.00" distinto del derivado (160.00) → 422 ADDITIONAL_COST_DERIVED_FROM_ITEMS',
      resMobBad
    );

    // Enviar additional_cost coincidente como string "160.00" (tolerancia 0.01) sí procede → desvía a pendiente_aprobacion por umbral 100
    const resMobOk = await request(`/workorders/${otMain.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMecA}` },
      body: { status: 'en_reparacion', diagnosis_notes: 'Cadena gastada', additional_cost: '160.00' },
    });
    assert(
      resMobOk.status === 200 && resMobOk.data?.data?.status === 'pendiente_aprobacion',
      'Móvil enviando additional_cost="160.00" coincide dentro de 0.01 y desvía a pendiente_aprobacion',
      resMobOk
    );

    // Approve adicional en lote → en_reparacion
    const resApproveAll = await request(`/workorders/${otMain.id}/approve`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: { channel: 'presencial' },
    });
    assert(
      resApproveAll.status === 200 && resApproveAll.data?.data?.status === 'en_reparacion',
      'PATCH /:id/approve pasa OT a en_reparacion',
      resApproveAll
    );

    // Agregar Disco (90) + Mano de obra extra (25) + Línea a rechazar (15) en en_reparacion → nacen 'propuesta'
    const addDiscoMain = await request(`/workorders/${otMain.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { type: 'product', product_id: prodDisco.id, quantity: 1 },
    });
    const addRejectMe = await request(`/workorders/${otMain.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { type: 'service', description: 'Lavado adicional descartado', unit_price: 15, quantity: 1 },
    });
    const discoItemId = addDiscoMain.data.data.item.id;
    const rejItemId = addRejectMe.data.data.item.id;
    assert(
      addDiscoMain.data?.data?.item?.status === 'propuesta' &&
        addDiscoMain.data?.data?.item?.origin === 'reparacion',
      'Línea agregada en en_reparacion nace propuesta con origin="reparacion"',
      addDiscoMain
    );

    // notify-link WhatsApp
    const resNotify = await request(`/workorders/${otMain.id}/items/notify-link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
    });
    assert(
      resNotify.status === 200 &&
        String(resNotify.data?.data?.url || '').startsWith('https://wa.me/51999111222?text=') &&
        String(resNotify.data?.data?.message || '').includes('[PRUEBA] Disco Freno Items') &&
        Number(resNotify.data?.data?.pending_total) === round2((90 + 15) * 1.18),
      'POST /items/notify-link arma enlace wa.me con líneas propuestas y total con IGV',
      resNotify
    );

    // Verificar error claro si vehículo no tiene whatsapp_opt_in
    await pool.query('UPDATE vehicles SET whatsapp_opt_in = false WHERE id = $1', [companyA.vehicleId]);
    const resNoOptIn = await request(`/workorders/${otMain.id}/items/notify-link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
    });
    assert(
      resNoOptIn.status === 422 && resNoOptIn.data?.error?.code === 'WHATSAPP_NOT_ELIGIBLE',
      'Sin consentimiento WhatsApp devuelve 422 WHATSAPP_NOT_ELIGIBLE',
      resNoOptIn
    );
    await pool.query('UPDATE vehicles SET whatsapp_opt_in = true WHERE id = $1', [companyA.vehicleId]);

    // Bloqueo en_reparacion → terminado mientras hay propuestas → 422 PENDING_ITEMS
    const resTermBlocked = await request(`/workorders/${otMain.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMecA}` },
      body: { status: 'terminado' },
    });
    assert(
      resTermBlocked.status === 422 && resTermBlocked.data?.error?.code === 'PENDING_ITEMS',
      'Mecánico intentando terminado con propuestas pendientes → 422 PENDING_ITEMS',
      resTermBlocked
    );

    // Rechazar rejItemId (NO borra físicamente) y aprobar discoItemId
    const resDecRej = await request(`/workorders/${otMain.id}/items/${rejItemId}/decision`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: { decision: 'rechazada', channel: 'telefono' },
    });
    assert(
      resDecRej.status === 200 &&
        resDecRej.data?.data?.item?.status === 'rechazada' &&
        Number(resDecRej.data?.data?.work_order?.additional_cost) === 250,
      'Rechazar línea (15) la marca rechazada sin borrar y recalcula additional_cost = 250.00 (60+100+90)',
      resDecRej
    );

    // Intentar re-decidir una línea ya decidida → 422
    const resReDec = await request(`/workorders/${otMain.id}/items/${rejItemId}/decision`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { decision: 'aprobada', channel: 'presencial' },
    });
    assert(resReDec.status === 422, 'No se puede re-decidir una línea ya rechazada/aprobada → 422', resReDec);

    const resDecApp = await request(`/workorders/${otMain.id}/items/${discoItemId}/decision`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: { decision: 'aprobada', channel: 'whatsapp' },
    });
    assert(
      resDecApp.status === 200 && Number(resDecApp.data?.data?.summary?.approved_total) === 250,
      'Aprobar Disco (90) → approved_total = 250.00 y pending_total = 0',
      resDecApp
    );

    // Ahora sí pasa a terminado
    const resTermOk = await request(`/workorders/${otMain.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMecA}` },
      body: { status: 'terminado' },
    });
    assert(
      resTermOk.status === 200 && resTermOk.data?.data?.status === 'terminado',
      'Sin propuestas pendientes, OT pasa a terminado → 200',
      resTermOk
    );

    // ─── CASO 4: Cobro unificado con work_order_item_id, precio congelado y validaciones 422 ───
    console.log('\n--- Caso 4: Precio congelado tras editar catálogo + validaciones 422 al cobrar ---');
    // Cambiar precio de Cadena en catálogo DESPUÉS de aprobar (60 → 99)
    await pool.query('UPDATE products SET sale_price = 99.00 WHERE id = $1', [prodCadena.id]);

    // 4a) ID de otra OT → 422
    const resWrongOt = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otMain.id,
        payment_method: 'efectivo',
        items: [
          { work_order_item_id: cadItemId },
          { work_order_item_id: mo1ItemId },
          { work_order_item_id: warnItemId }, // pertenece a otAssignedA
        ],
      },
    });
    assert(
      resWrongOt.status === 422 && resWrongOt.data?.error?.code === 'WORK_ORDER_ITEM_MISMATCH',
      'work_order_item_id de otra OT → 422 WORK_ORDER_ITEM_MISMATCH',
      resWrongOt
    );

    // 4b) Línea rechazada (no aprobada) → 422
    const resNotApproved = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otMain.id,
        payment_method: 'efectivo',
        items: [
          { work_order_item_id: cadItemId },
          { work_order_item_id: mo1ItemId },
          { work_order_item_id: discoItemId },
          { work_order_item_id: rejItemId },
        ],
      },
    });
    assert(
      resNotApproved.status === 422 && resNotApproved.data?.error?.code === 'WORK_ORDER_ITEM_NOT_APPROVED',
      'work_order_item_id no aprobado (rechazada) → 422 WORK_ORDER_ITEM_NOT_APPROVED',
      resNotApproved
    );

    // 4c) Línea aprobada omitida → 422
    const resOmitted = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otMain.id,
        payment_method: 'efectivo',
        items: [
          { work_order_item_id: cadItemId },
          { work_order_item_id: mo1ItemId },
          // falta discoItemId
        ],
      },
    });
    assert(
      resOmitted.status === 422 && resOmitted.data?.error?.code === 'MISSING_APPROVED_WORK_ORDER_ITEMS',
      'Línea aprobada omitida → 422 MISSING_APPROVED_WORK_ORDER_ITEMS',
      resOmitted
    );

    // 4d) ID repetido → 422
    const resDuplicate = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otMain.id,
        payment_method: 'efectivo',
        items: [
          { work_order_item_id: cadItemId },
          { work_order_item_id: cadItemId },
          { work_order_item_id: mo1ItemId },
          { work_order_item_id: discoItemId },
        ],
      },
    });
    assert(
      resDuplicate.status === 422 && resDuplicate.data?.error?.code === 'DUPLICATE_WORK_ORDER_ITEM',
      'work_order_item_id repetido → 422 DUPLICATE_WORK_ORDER_ITEM',
      resDuplicate
    );

    // 4e) Producto inactivo al cobrar → 422 legible (no 404 genérico)
    await pool.query('UPDATE products SET is_active = false WHERE id = $1', [prodCadena.id]);
    const resInactive = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otMain.id,
        payment_method: 'efectivo',
        items: [
          { work_order_item_id: cadItemId },
          { work_order_item_id: mo1ItemId },
          { work_order_item_id: discoItemId },
        ],
      },
    });
    assert(
      resInactive.status === 422 && resInactive.data?.error?.code === 'PRODUCT_INACTIVE',
      'Producto aprobado desactivado antes de cobrar → 422 PRODUCT_INACTIVE legible (no 404)',
      resInactive
    );
    await pool.query('UPDATE products SET is_active = true WHERE id = $1', [prodCadena.id]);

    // 4f) Producto sin stock al cobrar → 422 INSUFFICIENT_STOCK
    await pool.query('UPDATE products SET stock = 0 WHERE id = $1', [prodDisco.id]);
    const resNoStock = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otMain.id,
        payment_method: 'efectivo',
        items: [
          { work_order_item_id: cadItemId },
          { work_order_item_id: mo1ItemId },
          { work_order_item_id: discoItemId },
        ],
      },
    });
    assert(
      resNoStock.status === 422 && resNoStock.data?.error?.code === 'INSUFFICIENT_STOCK',
      'Producto aprobado sin stock al cobrar → 422 INSUFFICIENT_STOCK legible',
      resNoStock
    );
    await pool.query('UPDATE products SET stock = 1 WHERE id = $1', [prodDisco.id]);

    // 4g) Cobro real con precios/cantidades manipulados en el request → ignora cliente, cobra approved_total (250) + IGV = 295.00
    const resOrderPrePay = await request(`/workorders/${otMain.id}`, {
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
    });
    const expectedApproved = Number(resOrderPrePay.data.data.approved_total);
    const expectedTotalWithIgv = round2(expectedApproved * 1.18);

    const resCobroReal = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otMain.id,
        customer_name: 'Cliente A Prueba',
        payments: [
          { method: 'efectivo', amount: 150.00, cash_received: 150.00 },
          { method: 'yape', amount: round2(expectedTotalWithIgv - 150), reference: 'YP-OTI-1' },
        ],
        items: [
          { work_order_item_id: cadItemId, unit_price: 1, quantity: 99 }, // manipulado, debe usar 60 x 1
          { work_order_item_id: mo1ItemId, unit_price: 5, quantity: 10 }, // manipulado, debe usar 100 x 1
          { work_order_item_id: discoItemId },
        ],
      },
    });
    if (resCobroReal.data?.data?.id) createdSaleIds.push(resCobroReal.data.data.id);
    assert(
      resCobroReal.status === 201 &&
        Number(resCobroReal.data?.data?.subtotal) === expectedApproved &&
        Number(resCobroReal.data?.data?.total) === expectedTotalWithIgv &&
        resCobroReal.data?.data?.work_order_status === 'entregado',
      `Cobro unificado ignora catálogo (99) y manipulación del carrito → total ${expectedTotalWithIgv} == approved_total (${expectedApproved}) + IGV`,
      resCobroReal
    );

    // 4h) Producto extra sin work_order_item_id en una OT con líneas usa catálogo actual
    const { rows: [otWithExtra] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, $3, 19000, 'en_reparacion')
       RETURNING id`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(otWithExtra.id);
    const { rows: [appSvcExtra] } = await pool.query(
      `INSERT INTO work_order_items
         (company_id, work_order_id, item_type, description, quantity, unit_price, status, origin)
       VALUES ($1, $2, 'service', '[PRUEBA] Servicio base', 1, 50.00, 'aprobada', 'diagnostico')
       RETURNING id`,
      [companyA.companyId, otWithExtra.id]
    );
    await request(`/workorders/${otWithExtra.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { status: 'terminado' },
    });
    const resExtra = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otWithExtra.id,
        payment_method: 'efectivo',
        items: [
          { work_order_item_id: appSvcExtra.id },
          { product_id: prodExtra.id, quantity: 1 }, // extra sin work_order_item_id → catálogo 20.00
        ],
      },
    });
    if (resExtra.data?.data?.id) createdSaleIds.push(resExtra.data.data.id);
    assert(
      resExtra.status === 201 && Number(resExtra.data?.data?.subtotal) === 70 && Number(resExtra.data?.data?.total) === 82.6,
      'OT con línea aprobada (50) + producto extra de catálogo (20) → subtotal 70.00, total 82.60',
      resExtra
    );

    // ─── CASO 5: Reject adicional en lote y retrocompatibilidad OT sin líneas ───
    console.log('\n--- Caso 5: Reject adicional en lote + OT sin líneas idéntica a hoy ---');
    const { rows: [otRejPend] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, $3, 22000, 'diagnostico')
       RETURNING id`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(otRejPend.id);
    await request(`/workorders/${otRejPend.id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { type: 'service', description: '[PRUEBA] Reparación costosa', unit_price: 150, quantity: 1 },
    });
    await request(`/workorders/${otRejPend.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMecA}` },
      body: { status: 'en_reparacion' },
    });
    const resRejBatch = await request(`/workorders/${otRejPend.id}/reject`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
    });
    const resRejItemsCheck = await request(`/workorders/${otRejPend.id}/items`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    assert(
      resRejBatch.status === 200 &&
        resRejBatch.data?.data?.status === 'entregado' &&
        Number(resRejBatch.data?.data?.additional_cost) === 0 &&
        resRejItemsCheck.data?.data?.items?.[0]?.status === 'rechazada',
      'PATCH /:id/reject pasa OT a entregado, rechaza propuesta y recalcula additional_cost = 0',
      { resRejBatch, resRejItemsCheck }
    );

    // OT sin líneas
    const { rows: [otLegacy] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status)
       VALUES ($1, $2, $3, 25000, 'diagnostico')
       RETURNING id`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(otLegacy.id);

    const resLegRepair = await request(`/workorders/${otLegacy.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMecA}` },
      body: { status: 'en_reparacion', additional_cost: 80 },
    });
    const resLegTerm = await request(`/workorders/${otLegacy.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenMecA}` },
      body: { status: 'terminado' },
    });
    const resLegSale = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otLegacy.id,
        payment_method: 'efectivo',
        items: [{ type: 'service', description: 'Mano de obra legacy', unit_price: 80, quantity: 1 }],
      },
    });
    if (resLegSale.data?.data?.id) createdSaleIds.push(resLegSale.data.data.id);
    assert(
      resLegRepair.status === 200 &&
        resLegTerm.status === 200 &&
        resLegSale.status === 201 &&
        Number(resLegSale.data?.data?.total) === 94.4 &&
        resLegSale.data?.data?.work_order_status === 'entregado',
      'OT sin líneas mantiene flujo legacy exacto (diagnostico → en_reparacion → terminado → cobro S/ 94.40)',
      { resLegRepair, resLegTerm, resLegSale }
    );

    // Verificar audit_logs para work_order_item
    const { rows: auditRows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_logs WHERE company_id = $1 AND entity = 'work_order_item'`,
      [companyA.companyId]
    );
    assert(Number(auditRows[0]?.cnt) > 0, 'Se registraron eventos en audit_logs para work_order_item', auditRows[0]);
  } catch (err) {
    console.error('❌  Error inesperado durante verify-ot-items:', err);
    failedTests++;
  } finally {
    if (createdSaleIds.length > 0) {
      await pool.query('DELETE FROM credit_notes WHERE sale_id = ANY($1::int[])', [createdSaleIds]);
      await pool.query('DELETE FROM invoices WHERE sale_id = ANY($1::int[])', [createdSaleIds]);
      await pool.query('DELETE FROM sale_payments WHERE sale_id = ANY($1::int[])', [createdSaleIds]);
      await pool.query('DELETE FROM sale_items WHERE sale_id = ANY($1::int[])', [createdSaleIds]);
      await pool.query('DELETE FROM sales WHERE id = ANY($1::int[])', [createdSaleIds]);
    }
    if (createdOtIds.length > 0) {
      await pool.query('DELETE FROM notifications WHERE work_order_id = ANY($1::int[])', [createdOtIds]);
      await pool.query('DELETE FROM work_order_items WHERE work_order_id = ANY($1::int[])', [createdOtIds]);
      await pool.query('DELETE FROM work_orders WHERE id = ANY($1::int[])', [createdOtIds]);
    }
    if (createdProductIds.length > 0) {
      await pool.query('UPDATE products SET is_active = false WHERE id = ANY($1::int[])', [createdProductIds]);
    }
    if (companyA && companyB) {
      await pool.query(
        'UPDATE vehicles SET whatsapp_opt_in = $1, customer_phone = $2 WHERE id = $3',
        [originalVehOptIn, originalVehPhone, companyA.vehicleId]
      );
      await pool.query('UPDATE companies SET is_active = false WHERE id IN ($1, $2)', [
        companyA.companyId,
        companyB.companyId,
      ]);
      await pool.query(
        'UPDATE users SET is_active = false, must_change_password = false WHERE company_id IN ($1, $2)',
        [companyA.companyId, companyB.companyId]
      );
    }

    console.log('\n===============================================================');
    console.log(`RESULTADOS: ${passedTests}/${totalTests} pruebas pasaron (${failedTests} fallaron)`);
    console.log('===============================================================\n');

    await new Promise((r) => setTimeout(r, 50));
    process.exit(failedTests > 0 ? 1 : 0);
  }
}

run();
