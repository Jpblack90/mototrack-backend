// =============================================================================
// scripts/tests/verify-cobro-ot.js
// Suite de verificación Alcance A: Cobro unificado de OT (mano de obra + repuestos)
//
// Cobertura:
// 1. Venta directa con ítem { type: 'service' } (subtotal sin IGV → +18% IGV, sin tocar stock).
// 2. Validaciones 422 de ítems servicio (descripción vacía / >200 chars, precio <= 0, qty inválida, mezcla product/service).
// 3. Cobro con work_order_id en estado inválido (diagnostico/pendiente_aprobacion) → 422.
// 4. Aislamiento multi-tenant: cobrar work_order_id de otra empresa → 404 WORK_ORDER_NOT_FOUND.
// 5. Flujo completo OT en 'terminado' (servicio + repuesto, pago mixto) → 201, OT pasa a 'entregado', is_billed = true.
// 6. Doble cobro sobre la misma OT → 409 WORK_ORDER_ALREADY_BILLED.
// 7. Cobro de OT en 'no_recogido' → 201, OT pasa a 'entregado', is_billed = true.
// 8. Facturación electrónica (boleta) + ticket + buildPseDocument (unidad 'ZZ' para servicio, 'NIU' para repuesto).
// 9. Anulación de venta mixta (servicio + producto): restaura stock SOLO del producto, OT NO vuelve a terminado,
//    emite Nota de Crédito con descripción de servicio y unidad 'ZZ'.
// =============================================================================

import 'dotenv/config';
import pool from '../../src/config/database.js';
import { buildPseDocument } from '../../src/modules/invoicing/invoicing.service.js';
import { seedTestCompany } from './seed-test-company.js';

if (process.env.NODE_ENV === 'production') {
  console.error('❌  Error: verify-cobro-ot.js no debe ejecutarse en producción.');
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
    throw new Error(`No se pudo iniciar sesión con ${email}: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.data.token;
}

async function run() {
  console.log('\n===============================================================');
  console.log('🧪  INICIANDO SUITE VERIFY-COBRO-OT: COBRO UNIFICADO DE OT');
  console.log('===============================================================\n');

  let companyA = null;
  let companyB = null;
  const createdOtIds = [];
  const createdSaleIds = [];
  let testProductId = null;

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

    const tokenAdminA = await login(companyA.adminEmail, companyA.adminPassword);
    const tokenCajeroA = await login(companyA.cajeroEmail, companyA.adminPassword);
    const tokenAdminB = await login(companyB.adminEmail, companyB.adminPassword);

    // Producto controlado [PRUEBA] para verificar stock exacto (sin afectar datos previos)
    const { rows: prodRows } = await pool.query(
      `INSERT INTO products (company_id, name, sku, sale_price, cost_price, stock, min_stock, is_active)
       VALUES ($1, '[PRUEBA] Pedal de cambios A', 'PRUEBA-COBRO-OT-1', 45.00, 28.00, 10, 2, true)
       ON CONFLICT (company_id, sku)
       DO UPDATE SET stock = 10, sale_price = 45.00, is_active = true
       RETURNING id, name, sale_price, stock`,
      [companyA.companyId]
    );
    testProductId = prodRows[0].id;

    // ─── CASO 1: Venta directa de servicio sin IGV en unit_price ───
    console.log('\n--- Caso 1: Venta directa de servicio (45.00 + 18% IGV = 53.10) ---');
    const resStandaloneService = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        customer_name: '[PRUEBA] Cliente Servicio Solo',
        payments: [{ method: 'efectivo', amount: 53.10, cash_received: 60.00 }],
        items: [
          { type: 'service', description: '[PRUEBA] Regulación de frenos', unit_price: 45.00, quantity: 1 },
        ],
      },
    });
    if (resStandaloneService.data?.data?.id) createdSaleIds.push(resStandaloneService.data.data.id);
    assert(
      resStandaloneService.status === 201 &&
        Number(resStandaloneService.data?.data?.subtotal) === 45 &&
        Number(resStandaloneService.data?.data?.igv) === 8.1 &&
        Number(resStandaloneService.data?.data?.total) === 53.1,
      'Venta de servicio calcula subtotal 45.00, IGV 8.10 y total 53.10 → 201',
      resStandaloneService
    );

    const standaloneId = resStandaloneService.data?.data?.id;
    const resGetStandalone = await request(`/sales/${standaloneId}`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    assert(
      resGetStandalone.status === 200 &&
        resGetStandalone.data?.data?.items?.[0]?.item_type === 'service' &&
        resGetStandalone.data?.data?.items?.[0]?.description === '[PRUEBA] Regulación de frenos',
      'GET /sales/:id retorna item_type="service" y description exacta',
      resGetStandalone
    );

    // ─── CASO 2: Validaciones 422 para ítems de servicio ───
    console.log('\n--- Caso 2: Validaciones de servicio (422) ---');
    const invalidCases = [
      {
        label: 'descripción vacía',
        item: { type: 'service', description: '   ', unit_price: 50, quantity: 1 },
      },
      {
        label: 'descripción > 200 caracteres',
        item: { type: 'service', description: 'X'.repeat(201), unit_price: 50, quantity: 1 },
      },
      {
        label: 'unit_price <= 0',
        item: { type: 'service', description: 'Mano de obra', unit_price: 0, quantity: 1 },
      },
      {
        label: 'quantity decimal 1.5',
        item: { type: 'service', description: 'Mano de obra', unit_price: 50, quantity: 1.5 },
      },
      {
        label: 'mezcla service con product_id',
        item: { type: 'service', product_id: testProductId, description: 'Mano de obra', unit_price: 50, quantity: 1 },
      },
    ];
    for (const ic of invalidCases) {
      const r = await request('/sales', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenAdminA}` },
        body: {
          payment_method: 'efectivo',
          items: [ic.item],
        },
      });
      assert(r.status === 422, `Rechaza servicio inválido (${ic.label}) → 422`, r);
    }

    // ─── CASO 3: OT en estado no cobrable ('diagnostico') → 422 ───
    console.log('\n--- Caso 3: OT en diagnostico no puede cobrarse (422) ---');
    const { rows: [otDiag] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status, additional_cost)
       VALUES ($1, $2, $3, 15000, 'diagnostico', 80.00)
       RETURNING id, status`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(otDiag.id);

    const resDiagSale = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otDiag.id,
        payment_method: 'efectivo',
        items: [{ type: 'service', description: 'Mano de obra', unit_price: 80.00, quantity: 1 }],
      },
    });
    assert(
      resDiagSale.status === 422 && resDiagSale.data?.error?.code === 'INVALID_TRANSITION',
      'Cobrar OT en "diagnostico" devuelve 422 INVALID_TRANSITION',
      resDiagSale
    );

    // ─── CASO 4: Aislamiento multi-tenant (OT de empresa B) → 404 ───
    console.log('\n--- Caso 4: Aislamiento multi-tenant en work_order_id (404) ---');
    const { rows: [otTermB] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status, additional_cost, terminado_at)
       VALUES ($1, $2, $3, 21000, 'terminado', 60.00, NOW())
       RETURNING id`,
      [companyB.companyId, companyB.vehicleId, companyB.mechanicId]
    );
    createdOtIds.push(otTermB.id);

    const resCrossTenant = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        work_order_id: otTermB.id,
        payment_method: 'efectivo',
        items: [{ type: 'service', description: 'Mano de obra', unit_price: 60.00, quantity: 1 }],
      },
    });
    assert(
      resCrossTenant.status === 404 && resCrossTenant.data?.error?.code === 'WORK_ORDER_NOT_FOUND',
      'Admin A cobrando OT de Empresa B devuelve 404 WORK_ORDER_NOT_FOUND',
      resCrossTenant
    );

    // ─── CASO 5: Cobro unificado OT en 'terminado' (mano de obra + repuesto + pago mixto) ───
    console.log('\n--- Caso 5: Cobro unificado OT en terminado → entregado + is_billed ---');
    const { rows: [otTermA] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status, additional_cost, terminado_at)
       VALUES ($1, $2, $3, 30500, 'terminado', 120.00, NOW())
       RETURNING id`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(otTermA.id);

    // Mano de obra 120.00 + Pedal 45.00 = subtotal 165.00 → IGV 29.70 → total 194.70
    const resUnified = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        customer_name: 'Cliente A Prueba',
        work_order_id: otTermA.id,
        payments: [
          { method: 'efectivo', amount: 100.00, cash_received: 100.00 },
          { method: 'yape', amount: 94.70, reference: 'YP-998877' },
        ],
        items: [
          { type: 'service', description: 'Mano de obra', unit_price: 120.00, quantity: 1 },
          { product_id: testProductId, quantity: 1 },
        ],
      },
    });
    const unifiedSaleId = resUnified.data?.data?.id;
    if (unifiedSaleId) createdSaleIds.push(unifiedSaleId);

    assert(
      resUnified.status === 201 &&
        Number(resUnified.data?.data?.subtotal) === 165 &&
        Number(resUnified.data?.data?.igv) === 29.7 &&
        Number(resUnified.data?.data?.total) === 194.7 &&
        resUnified.data?.data?.work_order_status === 'entregado',
      'Cobro unificado (servicio 120 + repuesto 45) → subtotal 165, total 194.70 y OT entregada (201)',
      resUnified
    );

    const { rows: [stockAfterSale] } = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [testProductId]
    );
    assert(stockAfterSale?.stock === 9, 'Stock del repuesto bajó de 10 a 9 (servicio no tocó inventario)', stockAfterSale);

    const resGetWo = await request(`/workorders/${otTermA.id}`, {
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
    });
    assert(
      resGetWo.status === 200 &&
        resGetWo.data?.data?.status === 'entregado' &&
        resGetWo.data?.data?.is_billed === true &&
        Number(resGetWo.data?.data?.sale_id) === unifiedSaleId,
      'GET /workorders/:id retorna status="entregado", is_billed=true y sale_id enlazado',
      resGetWo
    );

    // ─── CASO 6: Doble cobro sobre la misma OT → 409 ───
    console.log('\n--- Caso 6: Doble cobro sobre la misma OT → 409 WORK_ORDER_ALREADY_BILLED ---');
    const resDouble = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        work_order_id: otTermA.id,
        payment_method: 'efectivo',
        items: [{ type: 'service', description: 'Mano de obra', unit_price: 120.00, quantity: 1 }],
      },
    });
    assert(
      resDouble.status === 409 && resDouble.data?.error?.code === 'WORK_ORDER_ALREADY_BILLED',
      'Segundo cobro a la misma OT devuelve 409 WORK_ORDER_ALREADY_BILLED',
      resDouble
    );

    // ─── CASO 7: Cobro de OT en 'no_recogido' → entregado ───
    console.log('\n--- Caso 7: Cobro de OT en no_recogido → entregado ---');
    const { rows: [otNoRecogido] } = await pool.query(
      `INSERT INTO work_orders (company_id, vehicle_id, mechanic_id, entry_mileage, status, additional_cost, terminado_at)
       VALUES ($1, $2, $3, 35000, 'no_recogido', 50.00, NOW() - INTERVAL '4 days')
       RETURNING id`,
      [companyA.companyId, companyA.vehicleId, companyA.mechanicId]
    );
    createdOtIds.push(otNoRecogido.id);

    const resNoRecogido = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        work_order_id: otNoRecogido.id,
        payment_method: 'tarjeta',
        items: [{ type: 'service', description: 'Mano de obra + custodia', unit_price: 50.00, quantity: 1 }],
      },
    });
    if (resNoRecogido.data?.data?.id) createdSaleIds.push(resNoRecogido.data.data.id);
    assert(
      resNoRecogido.status === 201 && resNoRecogido.data?.data?.work_order_status === 'entregado',
      'Cobro de OT en "no_recogido" transiciona a "entregado" → 201',
      resNoRecogido
    );

    // ─── CASO 8: Boleta electrónica + Ticket + Nubefact ZZ/NIU ───
    console.log('\n--- Caso 8: Boleta electrónica, Ticket y unidad ZZ en Nubefact ---');
    const resBoleta = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
      body: {
        sale_id: unifiedSaleId,
        comprobante_type: 'boleta',
        customer_document_type: 'DNI',
        customer_document_number: '12345678',
      },
    });
    const invoiceId = resBoleta.data?.data?.id;
    assert(
      resBoleta.status === 201 &&
        resBoleta.data?.data?.estado === 'accepted' &&
        String(resBoleta.data?.data?.xml_content || '').includes('Mano de obra') &&
        String(resBoleta.data?.data?.xml_content || '').includes('[PRUEBA] Pedal de cambios A'),
      'Boleta emitida con éxito incluyendo descripción del servicio y nombre del repuesto en XML',
      resBoleta
    );

    const resTicket = await request(`/invoicing/${invoiceId}/ticket`, {
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
    });
    const ticketItems = resTicket.data?.data?.sale?.items || resTicket.data?.data?.items || [];
    assert(
      resTicket.status === 200 &&
        ticketItems.some((it) => it.item_type === 'service' && it.description === 'Mano de obra') &&
        ticketItems.some((it) => it.item_type === 'product' && it.description === '[PRUEBA] Pedal de cambios A'),
      'GET /invoicing/:id/ticket devuelve descripción de servicio ("Mano de obra") y producto',
      resTicket
    );

    const saleDetailRes = await request(`/sales/${unifiedSaleId}`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const pseDoc = buildPseDocument({
      comprobanteType: 'boleta',
      serie: resBoleta.data?.data?.serie || 'B001',
      numero: resBoleta.data?.data?.numero || 1,
      sale: saleDetailRes.data?.data,
      customerDocType: 'DNI',
      customerDocNumber: '12345678',
    });
    assert(
      pseDoc.items?.[0]?.unidad_de_medida === 'ZZ' &&
        pseDoc.items?.[0]?.codigo === 'SERV' &&
        pseDoc.items?.[0]?.descripcion === 'Mano de obra' &&
        pseDoc.items?.[1]?.unidad_de_medida === 'NIU',
      'buildPseDocument genera unidad_de_medida="ZZ" para servicio y "NIU" para producto',
      pseDoc.items
    );

    // ─── CASO 9: Anulación de venta mixta + Nota de Crédito ───
    console.log('\n--- Caso 9: Anulación de venta mixta y Nota de Crédito con servicio ---');
    const resVoid = await request(`/sales/${unifiedSaleId}/void`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        void_reason: '[PRUEBA] Error en monto cobrado de mano de obra',
        motivo_code: '01',
      },
    });
    const { rows: [voidAuditRow] } = await pool.query(
      `SELECT changes FROM audit_logs WHERE company_id = $1 AND entity = 'sale' AND entity_id = $2 AND action = 'void' ORDER BY id DESC LIMIT 1`,
      [companyA.companyId, unifiedSaleId]
    );
    const restoredAudit = voidAuditRow?.changes?.restored_stock || [];
    assert(
      resVoid.status === 200 &&
        resVoid.data?.data?.status === 'voided' &&
        Array.isArray(restoredAudit) &&
        restoredAudit.length === 1 &&
        restoredAudit[0].product_id === testProductId &&
        resVoid.data?.data?.credit_note?.id != null,
      'voidSale restaura solo el repuesto, ignora servicio y genera Nota de Crédito → 200',
      { resVoid, voidAuditRow }
    );

    const { rows: [stockAfterVoid] } = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [testProductId]
    );
    assert(stockAfterVoid?.stock === 10, 'Stock del repuesto volvió de 9 a 10 tras anulación', stockAfterVoid);

    const { rows: [woAfterVoid] } = await pool.query(
      'SELECT status FROM work_orders WHERE id = $1',
      [otTermA.id]
    );
    assert(
      woAfterVoid?.status === 'entregado',
      'Tras anular la venta, la OT permanece en "entregado" (no vuelve a terminado)',
      woAfterVoid
    );

    const ncId = resVoid.data?.data?.credit_note?.id;
    const resNcTicket = await request(`/invoicing/credit-notes/${ncId}/ticket`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const ncItems = resNcTicket.data?.data?.sale?.items || resNcTicket.data?.data?.items || [];
    assert(
      resNcTicket.status === 200 &&
        String(resVoid.data?.data?.credit_note?.xml_content || '').includes('Mano de obra') &&
        ncItems.some((it) => it.item_type === 'service' && it.description === 'Mano de obra'),
      'Nota de Crédito incluye la línea de servicio tanto en xml_content como en ticket',
      { ncItems }
    );

    const pseNcDoc = buildPseDocument({
      comprobanteType: 'boleta',
      serie: resVoid.data?.data?.credit_note?.serie || 'BC01',
      numero: resVoid.data?.data?.credit_note?.numero || 1,
      sale: saleDetailRes.data?.data,
      customerDocType: 'DNI',
      customerDocNumber: '12345678',
      creditNote: resVoid.data?.data?.credit_note,
      invoiceModificado: resBoleta.data?.data,
    });
    assert(
      pseNcDoc.items?.[0]?.unidad_de_medida === 'ZZ' &&
        pseNcDoc.items?.[0]?.descripcion === 'Mano de obra' &&
        pseNcDoc.items?.[1]?.unidad_de_medida === 'NIU',
      'Nota de Crédito en Nubefact mantiene unidad_de_medida="ZZ" para servicio y "NIU" para producto',
      pseNcDoc.items
    );

    // Empresa B tampoco queda sin limpieza de serie/stock; ya terminamos
    void tokenAdminB;

  } catch (err) {
    console.error('❌  Error inesperado durante verify-cobro-ot:', err);
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
      await pool.query('DELETE FROM work_orders WHERE id = ANY($1::int[])', [createdOtIds]);
    }
    if (testProductId) {
      await pool.query('UPDATE products SET stock = 10, is_active = false WHERE id = $1', [testProductId]);
    }
    if (companyA && companyB) {
      await pool.query('DELETE FROM invoice_series WHERE company_id IN ($1, $2)', [
        companyA.companyId,
        companyB.companyId,
      ]);
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
