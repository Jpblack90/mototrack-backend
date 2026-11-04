// =============================================================================
// scripts/tests/verify-12-3.js
// Suite de verificación Tarea 12.3: Notas de Crédito Electrónicas (RF-23).
// Utiliza exclusivamente empresas de prueba "[PRUEBA]".
// Imprime [PASA] o [FALLA] para cada caso de prueba.
// =============================================================================

import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';

if (process.env.NODE_ENV === 'production') {
  console.error('❌  Error: verify-12-3.js no debe ejecutarse en producción.');
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
  } catch (err) {
    // respuesta no JSON
  }
  return { status: res.status, ok: res.ok, data };
}

async function runTests() {
  console.log('\n===============================================================');
  console.log('🧪  INICIANDO SUITE VERIFY-12-3: NOTAS DE CRÉDITO ELECTRÓNICAS (RF-23)');
  console.log('===============================================================\n');

  let company;
  let token;
  let testProductId;

  try {
    // 1. Obtener empresas de prueba
    const { companyB } = await seedTestCompany();
    company = companyB;
    const secret = process.env.JWT_SECRET || 'jwt_secret_dev_12345';
    token = jwt.sign(
      {
        id: company.adminId,
        email: company.adminEmail,
        role: 'admin',
        company_id: company.companyId,
      },
      secret,
      { expiresIn: '2h' }
    );

    // Limpiar transacciones previas de la empresa de prueba
    await pool.query(`DELETE FROM credit_notes WHERE company_id = $1`, [company.companyId]);
    await pool.query(`DELETE FROM invoices WHERE company_id = $1`, [company.companyId]);
    await pool.query(`DELETE FROM invoice_series WHERE company_id = $1`, [company.companyId]);
    await pool.query(`DELETE FROM sale_payments WHERE company_id = $1`, [company.companyId]);
    await pool.query(
      `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)`,
      [company.companyId]
    );
    await pool.query(`DELETE FROM sales WHERE company_id = $1`, [company.companyId]);

    // 2. Crear un producto de prueba para verificar restitución de stock
    const { rows: prodRows } = await pool.query(
      `INSERT INTO products (company_id, name, sku, sale_price, cost_price, stock, min_stock, is_active)
       VALUES ($1, '[PRUEBA] Aceite Sintético 10W40', 'PRUEBA-SKU-NC-1', 45.00, 30.00, 10, 2, true)
       ON CONFLICT (company_id, sku)
       DO UPDATE SET stock = 10, is_active = true
       RETURNING id, stock`,
      [company.companyId]
    );
    testProductId = prodRows[0].id;

    // Helper para crear una venta con items de prueba
    async function createTestSale(qty = 2) {
      const saleRes = await request('/sales', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: {
          items: [{ product_id: testProductId, quantity: qty }],
          payment_method: 'efectivo',
        },
      });
      return saleRes.data?.data;
    }

    // Helper para emitir comprobante
    async function issueInvoice(saleId, type, simulatePseDown = false) {
      const invRes = await request('/invoicing', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: {
          sale_id: saleId,
          comprobante_type: type,
          customer_document_type: type === 'factura' ? 'RUC' : 'DNI',
          customer_document_number: type === 'factura' ? '20123456789' : '71234567',
          simulatePseDown,
        },
      });
      return invRes.data?.data;
    }

    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 1: Venta con boleta -> Anular con motivo 01 ---');
    // ─────────────────────────────────────────────────────────────────────────
    const sale1 = await createTestSale(2); // Stock baja de 10 a 8
    assert(sale1?.id != null, 'Venta 1 creada exitosamente');

    const inv1 = await issueInvoice(sale1.id, 'boleta', false);
    assert(inv1?.estado === 'accepted', 'Boleta emitida en estado accepted', `estado: ${inv1?.estado}`);

    // Stock actual debe ser 8
    const { rows: stockBeforeVoid } = await pool.query(
      `SELECT stock FROM products WHERE id = $1`,
      [testProductId]
    );
    assert(stockBeforeVoid[0].stock === 8, 'Stock decrementado a 8 tras la venta');

    // Anular venta con motivo '01'
    const void1Res = await request(`/sales/${sale1.id}/void`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        void_reason: 'Cliente cancela la compra en mostrador',
        motivo_code: '01',
      },
    });

    assert(void1Res.status === 200, 'Endpoint /api/sales/:id/void responde 200 al anular con boleta');
    const void1Data = void1Res.data?.data;
    assert(void1Data?.status === 'voided', 'La venta 1 tiene status = voided');
    assert(
      void1Data?.credit_note?.serie === 'BC01' && void1Data?.credit_note?.estado === 'accepted',
      'Nota de crédito BC01 creada y aceptada por SUNAT (simulada)',
      `serie: ${void1Data?.credit_note?.serie}, numero: ${void1Data?.credit_note?.numero}, estado: ${void1Data?.credit_note?.estado}`
    );

    // Stock debe haberse restituido a 10
    const { rows: stockAfterVoid1 } = await pool.query(
      `SELECT stock FROM products WHERE id = $1`,
      [testProductId]
    );
    assert(stockAfterVoid1[0].stock === 10, 'Stock restituido a 10 tras la anulación');

    // Verificar que GET /api/invoicing ahora referencia la NC
    const listInvRes = await request('/invoicing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const invWithNc = listInvRes.data?.data?.find((i) => i.id === inv1.id);
    assert(
      invWithNc?.credit_note?.serie === 'BC01' && invWithNc?.credit_note?.numero === void1Data.credit_note.numero,
      'GET /api/invoicing incluye el objeto credit_note asociado al comprobante',
      `credit_note: ${JSON.stringify(invWithNc?.credit_note)}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 2: Anular boleta con motivo 02 (debe dar 422) ---');
    // ─────────────────────────────────────────────────────────────────────────
    const sale2 = await createTestSale(1);
    const inv2 = await issueInvoice(sale2.id, 'boleta', false);

    const void2Res = await request(`/sales/${sale2.id}/void`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        void_reason: 'Intento inválido de motivo 02 con boleta',
        motivo_code: '02',
      },
    });

    assert(
      void2Res.status === 422,
      'Intentar anular una boleta con motivo 02 responde 422 (solo permitido para facturas)',
      `status: ${void2Res.status}, error: ${void2Res.data?.error?.message}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 3: Venta con factura -> Anular con motivo 02 ---');
    // ─────────────────────────────────────────────────────────────────────────
    const sale3 = await createTestSale(1);
    const inv3 = await issueInvoice(sale3.id, 'factura', false);
    assert(inv3?.comprobante_type === 'factura', 'Factura emitida');

    const void3Res = await request(`/sales/${sale3.id}/void`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        void_reason: 'Error en el RUC digitado por el cliente',
        motivo_code: '02',
      },
    });

    assert(void3Res.status === 200, 'Anulación con factura y motivo 02 responde 200');
    const void3Data = void3Res.data?.data;
    assert(
      void3Data?.credit_note?.serie === 'FC01' && void3Data?.credit_note?.motivo_code === '02',
      'Nota de crédito emitida con serie FC01 y motivo 02',
      `serie: ${void3Data?.credit_note?.serie}, motivo: ${void3Data?.credit_note?.motivo_code}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 4: Venta con comprobante en contingencia -> Debe rechazar con 409 ---');
    // ─────────────────────────────────────────────────────────────────────────
    const sale4 = await createTestSale(1);
    const inv4 = await issueInvoice(sale4.id, 'boleta', true); // simulatePseDown = true
    assert(inv4?.estado === 'contingency', 'Comprobante quedó en contingencia');

    const void4Res = await request(`/sales/${sale4.id}/void`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        void_reason: 'Anular antes de sincronizar',
        motivo_code: '01',
      },
    });

    assert(
      void4Res.status === 409,
      'Intentar anular con comprobante en contingencia responde 409 con mensaje claro',
      `status: ${void4Res.status}, mensaje: "${void4Res.data?.error?.message}"`
    );
    assert(
      void4Res.data?.error?.message?.includes('aún no fue aceptado por SUNAT'),
      'El mensaje explica al usuario que debe reintentar el envío antes de anular'
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 5: Idempotencia: anular venta ya anulada -> 409 ---');
    // ─────────────────────────────────────────────────────────────────────────
    const void5Res = await request(`/sales/${sale1.id}/void`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        void_reason: 'Segundo intento de anulación',
        motivo_code: '01',
      },
    });

    assert(
      void5Res.status === 409 || void5Res.status === 422,
      'Intentar anular una venta ya anulada responde 409/422 (idempotencia garantizada)',
      `status: ${void5Res.status}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 6: Venta sin comprobante -> Se anula directo sin NC ---');
    // ─────────────────────────────────────────────────────────────────────────
    const { rows: stockBeforeSale6Rows } = await pool.query(
      `SELECT stock FROM products WHERE id = $1`,
      [testProductId]
    );
    const stockBefore6 = stockBeforeSale6Rows[0].stock;

    const sale6 = await createTestSale(3); // Stock baja en 3
    const void6Res = await request(`/sales/${sale6.id}/void`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        void_reason: 'Venta de mostrador sin comprobante cancelada',
      },
    });

    assert(void6Res.status === 200, 'Venta sin comprobante se anula con 200');
    assert(
      void6Res.data?.data?.credit_note == null,
      'No se genera ninguna Nota de Crédito para ventas sin comprobante'
    );

    // Verificar que el stock se restituyó exactamente en las 3 unidades vendidas
    const { rows: stockFinal } = await pool.query(
      `SELECT stock FROM products WHERE id = $1`,
      [testProductId]
    );
    assert(
      stockFinal[0].stock === stockBefore6,
      'El stock se restituyó exactamente al nivel previo a la venta sin comprobante',
      `stock_esperado: ${stockBefore6}, stock_actual: ${stockFinal[0].stock}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 7: Ticket y Dashboard con Notas de Crédito ---');
    // ─────────────────────────────────────────────────────────────────────────
    const ncTicketRes = await request(`/invoicing/credit-notes/${void1Data.credit_note.id}/ticket`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(ncTicketRes.status === 200, 'GET /api/invoicing/credit-notes/:id/ticket responde 200');
    assert(
      ncTicketRes.data?.data?.credit_note?.serie === 'BC01' &&
      ncTicketRes.data?.data?.modified_document?.serie === 'B001',
      'Ticket de NC contiene la referencia al documento que modifica (B001)'
    );

    const dashRes = await request('/dashboard', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ncDash = dashRes.data?.data?.invoicing?.credit_notes;
    assert(
      dashRes.status === 200 && ncDash?.count >= 2,
      'Dashboard incluye el conteo y total de notas de crédito del periodo',
      `count: ${ncDash?.count}, total: S/ ${ncDash?.total}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 8: Rollback real (falla forzada antes del COMMIT) ---');
    // ─────────────────────────────────────────────────────────────────────────
    // Crear una venta con boleta para probar el rollback
    const saleRollback = await createTestSale(1);
    const invRollback = await issueInvoice(saleRollback.id, 'boleta', false);
    assert(invRollback?.estado === 'accepted', 'Boleta para prueba de rollback emitida');

    // Registrar estado previo: stock del producto, correlativo actual de BC01
    const { rows: stockPreRows } = await pool.query(
      `SELECT stock FROM products WHERE id = $1`,
      [testProductId]
    );
    const stockPre = stockPreRows[0].stock;

    const { rows: seriesPreRows } = await pool.query(
      `SELECT last_number FROM invoice_series WHERE company_id = $1 AND serie = 'BC01'`,
      [company.companyId]
    );
    const correlativoPre = seriesPreRows[0]?.last_number ?? 0;

    // Ejecutar anulación forzando error después de insertar la NC y antes del COMMIT
    const voidRollbackRes = await request(`/sales/${saleRollback.id}/void`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Force-Void-Fail': '1',
      },
      body: {
        void_reason: 'Intento de anulación que fallará antes del commit',
        motivo_code: '01',
        _force_void_fail: true,
      },
    });

    assert(
      voidRollbackRes.status >= 400,
      'La llamada a voidSale falla cuando se fuerza un error antes del COMMIT',
      `status: ${voidRollbackRes.status}`
    );

    // Verificar en BD que todo se revirtió (Rollback real):
    // 1. La venta sigue en 'completed'
    const { rows: salePostRows } = await pool.query(
      `SELECT status FROM sales WHERE id = $1`,
      [saleRollback.id]
    );
    assert(
      salePostRows[0]?.status === 'completed',
      'La venta sigue en status = "completed" tras el rollback',
      `status: ${salePostRows[0]?.status}`
    );

    // 2. El stock no cambió
    const { rows: stockPostRows } = await pool.query(
      `SELECT stock FROM products WHERE id = $1`,
      [testProductId]
    );
    assert(
      stockPostRows[0]?.stock === stockPre,
      'El stock del producto no sufrió cambios tras el rollback',
      `pre: ${stockPre}, post: ${stockPostRows[0]?.stock}`
    );

    // 3. No existe la NC
    const { rows: ncRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM credit_notes WHERE sale_id = $1`,
      [saleRollback.id]
    );
    assert(
      ncRows[0]?.count === 0,
      'No existe registro de Nota de Crédito en la base de datos tras el rollback',
      `count: ${ncRows[0]?.count}`
    );

    // 4. El correlativo BC01 no se consumió
    const { rows: seriesPostRows } = await pool.query(
      `SELECT last_number FROM invoice_series WHERE company_id = $1 AND serie = 'BC01'`,
      [company.companyId]
    );
    const correlativoPost = seriesPostRows[0]?.last_number ?? 0;
    assert(
      correlativoPost === correlativoPre,
      'El correlativo numérico de la serie BC01 no se consumió tras el rollback',
      `pre: ${correlativoPre}, post: ${correlativoPost}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Caso 9: Facturar una venta ya anulada -> Rechazado (422) ---');
    // ─────────────────────────────────────────────────────────────────────────
    const invVoidedRes = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        sale_id: sale6.id,
        comprobante_type: 'boleta',
      },
    });

    assert(
      invVoidedRes.status === 422,
      'Intentar facturar una venta anulada responde HTTP 422',
      `status: ${invVoidedRes.status}`
    );
    assert(
      invVoidedRes.data?.error?.message?.includes('anulada') ||
      invVoidedRes.data?.error?.code === 'CANNOT_INVOICE_VOIDED_SALE',
      'El error indica claramente que no se puede emitir comprobante para una venta anulada',
      `code: ${invVoidedRes.data?.error?.code}, mensaje: "${invVoidedRes.data?.error?.message}"`
    );

  } catch (err) {
    console.error('💥  Error inesperado durante la ejecución de las pruebas:', err);
    failedTests++;
  } finally {
    if (company) {
      try {
        await pool.query(
          `DELETE FROM credit_notes WHERE company_id = $1`,
          [company.companyId]
        );
        await pool.query(
          `DELETE FROM invoices WHERE company_id = $1`,
          [company.companyId]
        );
        await pool.query(
          `DELETE FROM invoice_series WHERE company_id = $1`,
          [company.companyId]
        );
        await pool.query(
          `DELETE FROM sale_payments WHERE company_id = $1`,
          [company.companyId]
        );
        await pool.query(
          `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)`,
          [company.companyId]
        );
        await pool.query(
          `DELETE FROM sales WHERE company_id = $1`,
          [company.companyId]
        );
        await pool.query(
          `UPDATE products SET is_active = false WHERE company_id = $1`,
          [company.companyId]
        );
        await pool.query(
          `UPDATE companies SET is_active = false WHERE id = $1`,
          [company.companyId]
        );
        console.log(`\n🧹  Limpieza completada: Empresa de prueba id=${company.companyId} desactivada.`);
      } catch (cleanErr) {
        console.error('Error al limpiar registros de prueba:', cleanErr.message);
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
    console.log('✅  TODAS LAS PRUEBAS DE NOTAS DE CRÉDITO PASARON CON ÉXITO.');
    console.log('===============================================================\n');
    process.exit(0);
  }
}

runTests();
