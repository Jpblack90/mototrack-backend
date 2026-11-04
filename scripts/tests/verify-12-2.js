// =============================================================================
// scripts/tests/verify-12-2.js
// Suite de verificación integral de la Tarea 12.2:
// Pagos mixtos en una misma venta (RF-24): efectivo, tarjeta, Yape y Plin,
// cálculo y control de vuelto, auditoría de stock y desglose en dashboard/ticket.
// Utiliza exclusivamente empresas de prueba con el prefijo "[PRUEBA]".
// =============================================================================

import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/database.js';

const API_BASE = process.env.API_URL || 'http://localhost:4000/api';
const JWT_SECRET = process.env.JWT_SECRET || 'MySecretK3yForJWTs1234567890!@#%^&*()_+|';

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
    // respuesta no JSON
  }

  return { status: res.status, ok: res.ok, data };
}

async function run() {
  console.log('\n===============================================================');
  console.log('🚀  VERIFICACIÓN INTEGRAL: TAREA 12.2 (PAGOS MIXTOS - RF-24)');
  console.log('===============================================================\n');

  let testCompanyId = null;
  let testUserId = null;
  let authToken = null;
  let testProductId = null;
  let testProduct2Id = null;

  try {
    // 0. Preparar empresa de prueba [PRUEBA] Taller B
    const { rows: compRows } = await pool.query(
      `SELECT id, razon_social FROM companies WHERE razon_social LIKE '[PRUEBA] Taller B%' LIMIT 1`
    );
    if (!compRows[0]) throw new Error('Empresa [PRUEBA] Taller B no encontrada.');
    testCompanyId = compRows[0].id;

    // Asegurar que la empresa esté activa
    await pool.query(`UPDATE companies SET is_active = true WHERE id = $1`, [testCompanyId]);

    // Obtener usuario admin de [PRUEBA] Taller B
    await pool.query(
      `UPDATE users SET is_active = true, role = 'admin' WHERE email = 'pruebab@mototrack.local'`
    );
    const { rows: uRows } = await pool.query(
      `SELECT id, email, role, company_id FROM users WHERE email = 'pruebab@mototrack.local' LIMIT 1`
    );
    if (!uRows[0]) throw new Error('Usuario pruebab@mototrack.local no encontrado.');
    testUserId = uRows[0].id;

    authToken = jwt.sign(
      {
        id: testUserId,
        email: uRows[0].email,
        role: uRows[0].role,
        company_id: testCompanyId,
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Limpiar transacciones de prueba previas de esta empresa
    await pool.query(`DELETE FROM invoices WHERE company_id = $1`, [testCompanyId]);
    await pool.query(`DELETE FROM invoice_series WHERE company_id = $1`, [testCompanyId]);
    await pool.query(`DELETE FROM sale_payments WHERE company_id = $1`, [testCompanyId]);
    await pool.query(
      `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)`,
      [testCompanyId]
    );
    await pool.query(`DELETE FROM sales WHERE company_id = $1`, [testCompanyId]);

    // Crear/actualizar productos de prueba con precios fijos para cálculos exactos:
    // Producto 1: precio venta S/ 35.00 (sin IGV), con IGV 18% = 35 * 1.18 = S/ 41.30.
    // Producto 2: precio venta S/ 50.8474576 -> con IGV aprox S/ 60.00.
    // O mejor, Producto con precio venta 35.00 -> total 41.30
    // Producto 2 con precio venta 50.85 -> total 60.00 (subtotal 50.85 + igv 9.15 = 60.00)
    // Combinados: 35.00 + 50.85 = 85.85; IGV = 15.45; Total = 101.30! Exactamente S/ 101.30!
    await pool.query(
      `INSERT INTO products (company_id, name, sku, cost_price, sale_price, stock, min_stock, is_active)
       VALUES ($1, '[PRUEBA] Aceite 10W40 12.2', 'PRU-12-P1', 20.00, 35.00, 100, 5, true)
       ON CONFLICT (company_id, sku) DO UPDATE
       SET sale_price = 35.00, stock = 100, is_active = true
       RETURNING id`,
      [testCompanyId]
    );
    const { rows: p1Rows } = await pool.query(
      `SELECT id FROM products WHERE company_id = $1 AND sku = 'PRU-12-P1'`,
      [testCompanyId]
    );
    testProductId = p1Rows[0].id;

    await pool.query(
      `INSERT INTO products (company_id, name, sku, cost_price, sale_price, stock, min_stock, is_active)
       VALUES ($1, '[PRUEBA] Pastillas Freno 12.2', 'PRU-12-P2', 30.00, 50.85, 100, 5, true)
       ON CONFLICT (company_id, sku) DO UPDATE
       SET sale_price = 50.85, stock = 100, is_active = true
       RETURNING id`,
      [testCompanyId]
    );
    const { rows: p2Rows } = await pool.query(
      `SELECT id FROM products WHERE company_id = $1 AND sku = 'PRU-12-P2'`,
      [testCompanyId]
    );
    testProduct2Id = p2Rows[0].id;

    console.log('--- Caso 1: Formato anterior con payment_method sigue funcionando -> 1 fila en sale_payments ---');
    // Venta de 1 unidad de P1 (total S/ 41.30)
    const res1 = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: {
        payment_method: 'efectivo',
        customer_name: '[PRUEBA] Cliente Formato Anterior',
        items: [{ product_id: testProductId, quantity: 1 }],
      },
    });

    const sale1 = res1.data?.data;
    assert(
      res1.status === 201 && sale1?.payment_method === 'efectivo' && Number(sale1?.total) === 41.30,
      'Venta con formato legado payment_method responde 201 y total 41.30',
      `status: ${res1.status}, method: ${sale1?.payment_method}, total: ${sale1?.total}`
    );

    const { rows: spRows1 } = await pool.query(
      `SELECT * FROM sale_payments WHERE sale_id = $1`,
      [sale1?.id]
    );
    assert(
      spRows1.length === 1 && spRows1[0].method === 'efectivo' && Number(spRows1[0].amount) === 41.30,
      'Genera exactamente 1 fila en sale_payments con amount igual al total',
      `filas: ${spRows1.length}, method: ${spRows1[0]?.method}, amount: ${spRows1[0]?.amount}`
    );

    console.log('--- Caso 2: Efectivo 60 + Yape 41.30 = total 101.30 -> 201, payment_method "mixto" y 2 filas ---');
    // Venta combinada de 1 unidad de P1 (35.00) y 1 unidad de P2 (50.85) -> Subtotal 85.85 + IGV 15.45 = 101.30
    const res2 = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: {
        payments: [
          { method: 'efectivo', amount: 60.00, cash_received: 100.00 },
          { method: 'yape', amount: 41.30, reference: '123456' },
        ],
        customer_name: '[PRUEBA] Cliente Pago Mixto',
        items: [
          { product_id: testProductId, quantity: 1 },
          { product_id: testProduct2Id, quantity: 1 },
        ],
      },
    });

    const sale2 = res2.data?.data;
    assert(
      res2.status === 201 && sale2?.payment_method === 'mixto' && Number(sale2?.total) === 101.30,
      'Venta mixta responde 201, payment_method="mixto" y total S/ 101.30',
      `status: ${res2.status}, method: ${sale2?.payment_method}, total: ${sale2?.total}`
    );

    const { rows: spRows2 } = await pool.query(
      `SELECT method, amount, reference, cash_received, change_given FROM sale_payments WHERE sale_id = $1 ORDER BY method ASC`,
      [sale2?.id]
    );
    assert(
      spRows2.length === 2,
      'Registra exactamente 2 filas en sale_payments',
      `filas encontradas: ${spRows2.length}`
    );
    const efecPayment = spRows2.find((p) => p.method === 'efectivo');
    const yapePayment = spRows2.find((p) => p.method === 'yape');
    assert(
      Number(efecPayment?.amount) === 60.00 &&
        Number(efecPayment?.cash_received) === 100.00 &&
        Number(efecPayment?.change_given) === 40.00,
      'Pago en efectivo guarda amount 60.00, cash_received 100.00 y change_given 40.00',
      `efectivo: amount=${efecPayment?.amount}, rec=${efecPayment?.cash_received}, vuelto=${efecPayment?.change_given}`
    );
    assert(
      Number(yapePayment?.amount) === 41.30 && yapePayment?.reference === '123456',
      'Pago en Yape guarda amount 41.30 y reference "123456"',
      `yape: amount=${yapePayment?.amount}, ref=${yapePayment?.reference}`
    );

    console.log('--- Caso 3: Pagos que no suman el total -> 422 PAYMENT_MISMATCH, no crea venta y stock NO cambia ---');
    const { rows: stockPreRows } = await pool.query(
      `SELECT stock FROM products WHERE id = $1`,
      [testProductId]
    );
    const stockPre = Number(stockPreRows[0].stock);

    // Intento con total 41.30 pagando 30.00 (falta)
    const res3a = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: {
        payments: [{ method: 'efectivo', amount: 30.00 }],
        customer_name: '[PRUEBA] Cliente Descuadre Menor',
        items: [{ product_id: testProductId, quantity: 1 }],
      },
    });

    assert(
      res3a.status === 422 && res3a.data?.error?.code === 'PAYMENT_MISMATCH',
      'Pagos que suman menos que el total responden 422 con código PAYMENT_MISMATCH',
      `status: ${res3a.status}, code: ${res3a.data?.error?.code}, msg: ${res3a.data?.error?.message}`
    );

    // Intento con total 41.30 pagando 50.00 (excede)
    const res3b = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: {
        payments: [{ method: 'efectivo', amount: 50.00 }],
        customer_name: '[PRUEBA] Cliente Descuadre Mayor',
        items: [{ product_id: testProductId, quantity: 1 }],
      },
    });

    assert(
      res3b.status === 422 && res3b.data?.error?.code === 'PAYMENT_MISMATCH',
      'Pagos que suman más que el total responden 422 con código PAYMENT_MISMATCH',
      `status: ${res3b.status}, code: ${res3b.data?.error?.code}, msg: ${res3b.data?.error?.message}`
    );

    const { rows: stockPostRows } = await pool.query(
      `SELECT stock FROM products WHERE id = $1`,
      [testProductId]
    );
    const stockPost = Number(stockPostRows[0].stock);
    assert(
      stockPre === stockPost,
      'Rollback ejecutado: el stock del producto se mantiene intacto tras error de descuadre',
      `stockPre: ${stockPre}, stockPost: ${stockPost}`
    );

    console.log('--- Caso 4: Efectivo con cash_received 100 por amount 41.30 -> change_given 58.70. cash_received menor -> 422 ---');
    const res4a = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: {
        payments: [{ method: 'efectivo', amount: 41.30, cash_received: 100.00 }],
        customer_name: '[PRUEBA] Cliente Vuelto Exacto',
        items: [{ product_id: testProductId, quantity: 1 }],
      },
    });

    const sale4a = res4a.data?.data;
    assert(
      res4a.status === 201,
      'Efectivo con cash_received 100 por amount 41.30 se procesa correctamente (201)'
    );

    const { rows: spRows4a } = await pool.query(
      `SELECT cash_received, change_given FROM sale_payments WHERE sale_id = $1`,
      [sale4a?.id]
    );
    assert(
      Number(spRows4a[0]?.cash_received) === 100.00 && Number(spRows4a[0]?.change_given) === 58.70,
      'Calcula correctamente change_given = 58.70 (100.00 - 41.30)',
      `cash_received: ${spRows4a[0]?.cash_received}, change_given: ${spRows4a[0]?.change_given}`
    );

    // Intento con cash_received menor a amount (recibido 30 para monto 41.30)
    const res4b = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: {
        payments: [{ method: 'efectivo', amount: 41.30, cash_received: 30.00 }],
        customer_name: '[PRUEBA] Cliente Recibido Menor',
        items: [{ product_id: testProductId, quantity: 1 }],
      },
    });
    assert(
      res4b.status === 422 && res4b.data?.error?.code === 'INVALID_FIELD',
      'Efectivo con cash_received menor a amount es rechazado con 422 INVALID_FIELD',
      `status: ${res4b.status}, code: ${res4b.data?.error?.code}`
    );

    console.log('--- Caso 5: Reglas de validación de métodos y vuelto ---');
    // Dos pagos en efectivo
    const res5a = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: {
        payments: [
          { method: 'efectivo', amount: 20.00 },
          { method: 'efectivo', amount: 21.30 },
        ],
        customer_name: '[PRUEBA] Doble Efectivo',
        items: [{ product_id: testProductId, quantity: 1 }],
      },
    });
    assert(
      res5a.status === 422 && res5a.data?.error?.message?.includes('Solo se permite un pago en efectivo'),
      'Dos pagos en efectivo en la misma venta son rechazados con 422',
      `status: ${res5a.status}, msg: ${res5a.data?.error?.message}`
    );

    // cash_received en un pago con Yape
    const res5b = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: {
        payments: [{ method: 'yape', amount: 41.30, cash_received: 50.00 }],
        customer_name: '[PRUEBA] Yape Con Vuelto',
        items: [{ product_id: testProductId, quantity: 1 }],
      },
    });
    assert(
      res5b.status === 422 && res5b.data?.error?.message?.includes('Solo el pago en efectivo acepta monto recibido'),
      'cash_received en Yape es rechazado con 422',
      `status: ${res5b.status}, msg: ${res5b.data?.error?.message}`
    );

    // Método inválido (ej. 'bitcoin')
    const res5c = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: {
        payments: [{ method: 'bitcoin', amount: 41.30 }],
        customer_name: '[PRUEBA] Metodo Invalido',
        items: [{ product_id: testProductId, quantity: 1 }],
      },
    });
    assert(
      res5c.status === 422,
      'Método de pago inválido es rechazado con 422',
      `status: ${res5c.status}, msg: ${res5c.data?.error?.message}`
    );

    console.log('--- Caso 6: El dashboard reparte correctamente por método ---');
    // Para esta empresa de prueba se han creado 3 ventas exitosas:
    // 1) 41.30 (efectivo)
    // 2) 101.30 (60.00 efectivo + 41.30 yape)
    // 4) 41.30 (efectivo)
    // Total efectivo esperado: 41.30 + 60.00 + 41.30 = 142.60 (3 pagos)
    // Total Yape esperado: 41.30 (1 pago)
    const resDash = await request('/dashboard', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const revenueByMethod = resDash.data?.data?.sales?.revenue_by_payment_method || [];
    const efecDash = revenueByMethod.find((m) => m.payment_method === 'efectivo');
    const yapeDash = revenueByMethod.find((m) => m.payment_method === 'yape');

    assert(
      Number(efecDash?.revenue) === 142.60 && efecDash?.count === 3,
      'Dashboard reporta en efectivo exactamente S/ 142.60 (3 pagos)',
      `efectivo dash: revenue=${efecDash?.revenue}, count=${efecDash?.count}`
    );
    assert(
      Number(yapeDash?.revenue) === 41.30 && yapeDash?.count === 1,
      'Dashboard reporta en Yape exactamente S/ 41.30 (1 pago)',
      `yape dash: revenue=${yapeDash?.revenue}, count=${yapeDash?.count}`
    );

    console.log('--- Caso 7: El ticket incluye los pagos ---');
    // Emitir factura/boleta de la venta mixta sale2 para verificar getTicketData
    const resInv = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: {
        sale_id: sale2.id,
        comprobante_type: 'boleta',
        serie: 'B001',
        customer_document_type: 'DNI',
        customer_document_number: '12345678',
        customer_name: '[PRUEBA] Cliente Boleta Mixta',
      },
    });

    const invoiceId = resInv.data?.data?.id;
    assert(
      resInv.status === 201 && invoiceId != null,
      'Comprobante emitido para la venta mixta con status 201'
    );

    const resTicket = await request(`/invoicing/${invoiceId}/ticket`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const ticketData = resTicket.data?.data;
    const ticketPayments = ticketData?.sale?.payments;

    assert(
      resTicket.status === 200 && Array.isArray(ticketPayments) && ticketPayments.length === 2,
      'getTicketData devuelve la lista de payments con 2 elementos',
      `payments length: ${ticketPayments?.length}`
    );

    const ticketEfec = ticketPayments?.find((p) => p.method === 'efectivo');
    const ticketYape = ticketPayments?.find((p) => p.method === 'yape');

    assert(
      Number(ticketEfec?.amount) === 60.00 &&
        Number(ticketEfec?.cash_received) === 100.00 &&
        Number(ticketEfec?.change_given) === 40.00,
      'Ticket refleja pago en efectivo con recibido S/ 100 y vuelto S/ 40',
      `ticket efec: amount=${ticketEfec?.amount}, rec=${ticketEfec?.cash_received}, vuelto=${ticketEfec?.change_given}`
    );
    assert(
      Number(ticketYape?.amount) === 41.30 && ticketYape?.reference === '123456',
      'Ticket refleja pago en Yape con monto S/ 41.30 y referencia "123456"',
      `ticket yape: amount=${ticketYape?.amount}, ref=${ticketYape?.reference}`
    );

  } catch (err) {
    console.error('❌ Error no controlado durante la ejecución de las pruebas:', err);
    failedTests++;
  } finally {
    // Limpieza de datos de prueba
    if (testCompanyId) {
      try {
        await pool.query(`DELETE FROM invoices WHERE company_id = $1`, [testCompanyId]);
        await pool.query(`DELETE FROM invoice_series WHERE company_id = $1`, [testCompanyId]);
        await pool.query(`DELETE FROM sale_payments WHERE company_id = $1`, [testCompanyId]);
        await pool.query(
          `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)`,
          [testCompanyId]
        );
        await pool.query(`DELETE FROM sales WHERE company_id = $1`, [testCompanyId]);
        await pool.query(
          `UPDATE products SET is_active = false WHERE company_id = $1 AND name LIKE '[PRUEBA]%'`,
          [testCompanyId]
        );
        await pool.query(`UPDATE companies SET is_active = false WHERE id = $1`, [testCompanyId]);
      } catch (cleanErr) {
        console.error('Error durante la limpieza de prueba:', cleanErr);
      }
    }
    await pool.end();
  }

  console.log('\n===============================================================');
  console.log(`RESULTADOS: ${passedTests} de ${totalTests} pruebas pasaron.`);
  if (failedTests > 0) {
    console.log(`❌  ${failedTests} prueba(s) fallaron.`);
    process.exit(1);
  } else {
    console.log('✅  Todas las pruebas de la Tarea 12.2 pasaron satisfactoriamente.');
    process.exit(0);
  }
}

run();
