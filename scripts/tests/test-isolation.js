// =============================================================================
// scripts/tests/test-isolation.js
// Prueba de aislamiento multi-tenant estricto entre Empresa A y Empresa B.
// Utiliza exclusivamente las empresas de prueba "[PRUEBA] Taller A" y "[PRUEBA] Taller B".
// Imprime [PASA] o [FALLA] para cada caso de prueba.
// ES Module — requiere "type": "module" en package.json.
// =============================================================================

import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';

// ─── 1. Protección de entorno ─────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  console.error('❌  Error: test-isolation.js no debe ejecutarse en entorno de producción.');
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
    // Respuesta no-JSON
  }
  return { status: res.status, ok: res.ok, data };
}

/**
 * Borra transacciones previas de una empresa de prueba asegurando su prefijo [PRUEBA].
 */
async function safeClearTestTransactions(companyId) {
  const { rows } = await pool.query(
    `SELECT razon_social FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows[0] || !rows[0].razon_social.startsWith('[PRUEBA]')) {
    console.error(
      `❌  Protección activada: La empresa ${companyId} ("${rows[0]?.razon_social}") no empieza con '[PRUEBA]'. Abortando sin borrar.`
    );
    process.exit(1);
  }
  await pool.query(`DELETE FROM credit_notes WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM invoices WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM invoice_series WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM sale_payments WHERE company_id = $1`, [companyId]);
  await pool.query(
    `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)`,
    [companyId]
  );
  await pool.query(`DELETE FROM sales WHERE company_id = $1`, [companyId]);
}

async function getRealCompanyCounts(realCompanyId) {
  const { rows: salesRows } = await pool.query(
    `SELECT COUNT(*)::INTEGER AS count FROM sales WHERE company_id = $1`,
    [realCompanyId]
  );
  const { rows: invRows } = await pool.query(
    `SELECT COUNT(*)::INTEGER AS count FROM invoices WHERE company_id = $1`,
    [realCompanyId]
  );
  const { rows: woRows } = await pool.query(
    `SELECT COUNT(*)::INTEGER AS count FROM work_orders WHERE company_id = $1`,
    [realCompanyId]
  );

  return {
    sales: salesRows[0].count,
    invoices: invRows[0].count,
    workOrders: woRows[0].count,
  };
}

async function run() {
  console.log('===============================================================');
  console.log('🧪  INICIANDO SUITE DE PRUEBAS DE AISLAMIENTO MULTI-TENANT');
  console.log('===============================================================\n');

  let companyAId, companyBId;
  let tokenA, tokenB;
  let realCompanyId, initialRealCounts;

  try {
    // 1. Obtener ID de la empresa real "Taller Principal" y registrar sus conteos iniciales
    const { rows: realCompRows } = await pool.query(
      `SELECT id, razon_social FROM companies WHERE razon_social = 'Taller Principal' LIMIT 1`
    );
    if (realCompRows.length > 0) {
      realCompanyId = realCompRows[0].id;
      initialRealCounts = await getRealCompanyCounts(realCompanyId);
      console.log(
        `🛡️  Empresa real protegida: "${realCompRows[0].razon_social}" (id: ${realCompanyId})`
      );
      console.log(
        `   Conteos iniciales: ${initialRealCounts.sales} ventas, ${initialRealCounts.invoices} facturas, ${initialRealCounts.workOrders} OT.\n`
      );
    }

    // 2. Inicializar empresas de prueba [PRUEBA] Taller A y [PRUEBA] Taller B
    const { companyA, companyB } = await seedTestCompany();
    companyAId = companyA.companyId;
    companyBId = companyB.companyId;

    // Validación estricta: ambas empresas deben empezar con [PRUEBA]
    const { rows: checkCompRows } = await pool.query(
      `SELECT id, razon_social FROM companies WHERE id IN ($1, $2)`,
      [companyAId, companyBId]
    );
    for (const c of checkCompRows) {
      if (!c.razon_social.startsWith('[PRUEBA]')) {
        throw new Error(
          `Seguridad violada: La empresa ${c.id} ("${c.razon_social}") no empieza con [PRUEBA]. Abortando prueba.`
        );
      }
    }

    console.log(`ℹ️  Empresa A (Prueba): id=${companyAId} ("${companyA.name}")`);
    console.log(`ℹ️  Empresa B (Prueba): id=${companyBId} ("${companyB.name}")\n`);

    // Limpiar transacciones previas de prueba de ambas empresas para repetibilidad
    await safeClearTestTransactions(companyAId);
    await safeClearTestTransactions(companyBId);

    // 3. Login Admin A y Admin B
    const loginARes = await request('/auth/login', {
      method: 'POST',
      body: { email: companyA.adminEmail, password: companyA.adminPassword },
    });
    if (!loginARes.ok) {
      throw new Error(`Login de Admin A falló: ${JSON.stringify(loginARes.data)}`);
    }
    tokenA = loginARes.data.data.token;

    const loginBRes = await request('/auth/login', {
      method: 'POST',
      body: { email: companyB.adminEmail, password: companyB.adminPassword },
    });
    if (!loginBRes.ok) {
      throw new Error(`Login de Admin B falló: ${JSON.stringify(loginBRes.data)}`);
    }
    tokenB = loginBRes.data.data.token;

    // ─────────────────────────────────────────────────────────────────────────
    // CASOS DE AISLAMIENTO
    // ─────────────────────────────────────────────────────────────────────────

    console.log('--- Caso 1: B intenta GET /api/inventory/:id_de_A -> 404 (no 403) ---');
    const c1 = await request(`/inventory/${companyA.productId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(c1.status === 404, 'B recibe 404 al intentar leer producto de A', `status: ${c1.status}`);

    console.log('--- Caso 1a: B consulta listados y ningún id pertenece a A ---');
    const { rows: pA } = await pool.query(`SELECT id FROM products WHERE company_id = $1`, [companyAId]);
    const { rows: sA } = await pool.query(`SELECT id FROM sales WHERE company_id = $1`, [companyAId]);
    const { rows: wA } = await pool.query(`SELECT id FROM work_orders WHERE company_id = $1`, [companyAId]);
    const { rows: iA } = await pool.query(`SELECT id FROM invoices WHERE company_id = $1`, [companyAId]);
    const { rows: uA } = await pool.query(`SELECT id FROM users WHERE company_id = $1`, [companyAId]);

    const idsProductsA = new Set(pA.map((r) => r.id));
    const idsSalesA = new Set(sA.map((r) => r.id));
    const idsOrdersA = new Set(wA.map((r) => r.id));
    const idsInvoicesA = new Set(iA.map((r) => r.id));
    const idsUsersA = new Set(uA.map((r) => r.id));

    const [listInv, listSales, listWO, listInvoices, listUsers] = await Promise.all([
      request('/inventory', { headers: { Authorization: `Bearer ${tokenB}` } }),
      request('/sales', { headers: { Authorization: `Bearer ${tokenB}` } }),
      request('/workorders', { headers: { Authorization: `Bearer ${tokenB}` } }),
      request('/invoicing', { headers: { Authorization: `Bearer ${tokenB}` } }),
      request('/users', { headers: { Authorization: `Bearer ${tokenB}` } }),
    ]);

    const hasAInInventory = (listInv.data?.data || []).some((item) => idsProductsA.has(item.id));
    const hasAInSales = (listSales.data?.data || []).some((item) => idsSalesA.has(item.id));
    const hasAInWO = (listWO.data?.data || []).some((item) => idsOrdersA.has(item.id));
    const hasAInInvoices = (listInvoices.data?.data || []).some((item) => idsInvoicesA.has(item.id));
    const hasAInUsers = (listUsers.data?.data || []).some((item) => idsUsersA.has(item.id));

    assert(
      !hasAInInventory && !hasAInSales && !hasAInWO && !hasAInInvoices && !hasAInUsers,
      'Ningún ID de los listados de B pertenece a la Empresa A (/inventory, /sales, /workorders, /invoicing, /users)'
    );

    console.log('--- Caso 1b: B crea OT con la MISMA placa que A -> 201 y 2 vehículos en BD ---');
    const postWoBRes = await request('/workorders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        placa: companyA.placa,
        brand: 'Honda',
        model: 'GL150',
        customer_name: 'Cliente B Con Misma Placa',
        customer_phone: '911222333',
        entry_mileage: 15000,
        checklist_notes: 'Prueba de placa cruzada entre Taller A y Taller B',
      },
    });
    const { rows: vehiclesWithPlaca } = await pool.query(
      `SELECT id, company_id, placa FROM vehicles WHERE placa = $1`,
      [companyA.placa]
    );
    assert(
      postWoBRes.status === 201 &&
        vehiclesWithPlaca.length === 2 &&
        vehiclesWithPlaca.some((v) => v.company_id === companyAId) &&
        vehiclesWithPlaca.some((v) => v.company_id === companyBId),
      'B crea OT con misma placa de A (201) y coexisten 2 vehículos con esa placa (uno por empresa)',
      `status: ${postWoBRes.status}, vehículos encontrados: ${vehiclesWithPlaca.length}`
    );

    console.log('--- Caso 1d: Token firmado sin company_id -> 401 ---');
    const fakeTokenWithoutCompany = jwt.sign(
      { id: 9999, email: 'externo@sinempresa.local', role: 'admin' },
      process.env.JWT_SECRET || 'dev_jwt_secret_change_in_production_12345'
    );
    const c1d = await request('/auth/me', {
      headers: { Authorization: `Bearer ${fakeTokenWithoutCompany}` },
    });
    assert(
      c1d.status === 401 && c1d.data?.error?.message?.includes('empresa'),
      'Token firmado sin company_id es rechazado con 401',
      `status: ${c1d.status}, message: ${c1d.data?.error?.message}`
    );

    console.log('--- Caso 2: B intenta PUT /api/inventory/:id_de_A -> 404 ---');
    const c2 = await request(`/inventory/${companyA.productId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { name: 'Nombre Modificado por B' },
    });
    assert(c2.status === 404, 'B recibe 404 al intentar actualizar producto de A', `status: ${c2.status}`);

    console.log('--- Caso 3: B intenta DELETE /api/inventory/:id_de_A -> 404 ---');
    const c3 = await request(`/inventory/${companyA.productId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(c3.status === 404, 'B recibe 404 al intentar eliminar producto de A', `status: ${c3.status}`);

    console.log('--- Caso 4: B puede crear producto con el mismo SKU que uno de A (unicidad por empresa) ---');
    // Limpieza preventiva si existía de una corrida previa
    await pool.query('DELETE FROM products WHERE company_id = $1 AND sku = $2', [companyBId, companyA.productSku]);
    const c4 = await request('/inventory', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        sku: companyA.productSku,
        name: '[PRUEBA] Producto B con mismo SKU que A',
        cost_price: 30,
        sale_price: 60,
        stock: 10,
        min_stock: 2,
      },
    });
    const prodBClone = c4.data?.data;
    assert(
      c4.status === 201 && prodBClone?.sku === companyA.productSku,
      'B crea exitosamente producto con el mismo SKU que A',
      `status: ${c4.status}, sku: ${prodBClone?.sku}`
    );

    console.log('--- Caso 5: B crea una venta con product_id de A -> 404 y stock de A intacto ---');
    const { rows: stockPre5 } = await pool.query(`SELECT stock FROM products WHERE id = $1`, [companyA.productId]);
    const initialStockA = stockPre5[0].stock;
    const c5 = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        customer_name: 'Cliente Prueba B',
        payment_method: 'efectivo',
        items: [{ product_id: companyA.productId, quantity: 2 }],
      },
    });
    const { rows: stockPost5 } = await pool.query(`SELECT stock FROM products WHERE id = $1`, [companyA.productId]);
    const finalStockA = stockPost5[0].stock;
    assert(
      c5.status === 404 && initialStockA === finalStockA,
      'Venta de B con producto de A rechazada con 404 y stock de A no cambia',
      `status: ${c5.status}, stock antes=${initialStockA}, stock después=${finalStockA}`
    );

    console.log('--- Caso 6: B intenta GET /api/workorders/:id_de_A -> 404 ---');
    const c6 = await request(`/workorders/${companyA.workOrderId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(c6.status === 404, 'B recibe 404 al consultar orden de trabajo de A', `status: ${c6.status}`);

    console.log('--- Caso 7: B crea venta usando kit_id de A -> 404 y stock de A no cambia ---');
    const { rows: stockPre7 } = await pool.query(`SELECT stock FROM products WHERE id = $1`, [companyA.productId]);
    const c7 = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        customer_name: 'Cliente Prueba B',
        payment_method: 'efectivo',
        items: [{ kit_id: companyA.kitId, quantity: 1 }],
      },
    });
    const { rows: stockPost7 } = await pool.query(`SELECT stock FROM products WHERE id = $1`, [companyA.productId]);
    assert(
      c7.status === 404 && stockPre7[0].stock === stockPost7[0].stock,
      'Venta de B con kit de A rechazada con 404 y componentes de A intactos',
      `status: ${c7.status}, stock=${stockPost7[0].stock}`
    );

    console.log('--- Caso 8: B intenta asignar mecánico de A a su orden de trabajo -> 404 ---');
    const c8 = await request(`/workorders/${companyB.workOrderId}/assign`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { mechanic_id: companyA.mechanicId },
    });
    assert(
      c8.status === 404,
      'B no puede asignar un mecánico de A a su orden de trabajo (404)',
      `status: ${c8.status}`
    );

    console.log('--- Caso 9: Correlativos independientes por empresa en serie B001 ---');
    const { rows: seriesBPre } = await pool.query(
      `SELECT last_number FROM invoice_series WHERE company_id = $1 AND serie = 'B001'`,
      [companyBId]
    );
    const lastBPre = seriesBPre[0]?.last_number ?? 0;

    const { rows: seriesAPre } = await pool.query(
      `SELECT last_number FROM invoice_series WHERE company_id = $1 AND serie = 'B001'`,
      [companyAId]
    );
    const lastAPre = seriesAPre[0]?.last_number ?? 0;

    // 1. B crea una venta con su producto
    const saleBRes = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        customer_name: 'Cliente B Facturación',
        payment_method: 'efectivo',
        items: [{ product_id: companyB.productId, quantity: 1 }],
      },
    });
    const saleB = saleBRes.data.data;

    const invBRes = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        sale_id: saleB.id,
        comprobante_type: 'boleta',
        customer_document_type: 'DNI',
        customer_document_number: '12345678',
      },
    });
    const invoiceB = invBRes.data.data;

    // 2. A crea una venta con su producto
    const saleARes = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: {
        customer_name: 'Cliente A Facturación',
        payment_method: 'efectivo',
        items: [{ product_id: companyA.productId, quantity: 1 }],
      },
    });
    const saleA = saleARes.data.data;

    const invARes = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: {
        sale_id: saleA.id,
        comprobante_type: 'boleta',
        customer_document_type: 'DNI',
        customer_document_number: '87654321',
      },
    });
    const invoiceA = invARes.data.data;

    console.log(
      `  ℹ️  Correlativos reales obtenidos: B: B001-${invoiceB?.numero} | A: B001-${lastAPre} → B001-${invoiceA?.numero}`
    );

    assert(
      invoiceB?.serie === 'B001' && invoiceB?.numero === 1,
      'Primera boleta de B en B001 tiene número 1',
      `numero B: ${invoiceB?.numero}`
    );
    assert(
      invoiceA?.serie === 'B001' &&
        invoiceA?.numero === lastAPre + 1 &&
        invoiceA?.id !== invoiceB?.id,
      `Boleta de A en B001 continúa su propia secuencia (B001-${lastAPre} → B001-${invoiceA?.numero})`,
      `numero A: ${invoiceA?.numero}, numero B: ${invoiceB?.numero}`
    );

    console.log('--- Caso 1c: Dashboard de B coincide con SELECT directo de B y difiere de A ---');
    const c10 = await request('/dashboard', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const dashSalesB = c10.data?.data?.sales;

    const { rows: bSalesDb } = await pool.query(
      `SELECT COUNT(*)::INTEGER AS count, COALESCE(SUM(total), 0)::NUMERIC AS revenue
       FROM sales
       WHERE company_id = $1 AND status = 'completed' AND created_at >= $2 AND created_at <= $3`,
      [companyBId, dashSalesB.period.from, dashSalesB.period.to]
    );

    const { rows: aSalesDb } = await pool.query(
      `SELECT COUNT(*)::INTEGER AS count, COALESCE(SUM(total), 0)::NUMERIC AS revenue
       FROM sales
       WHERE company_id = $1 AND status = 'completed' AND created_at >= $2 AND created_at <= $3`,
      [companyAId, dashSalesB.period.from, dashSalesB.period.to]
    );

    const matchesB =
      Number(dashSalesB.total_sales_count) === Number(bSalesDb[0].count) &&
      Number(dashSalesB.total_revenue) === Number(bSalesDb[0].revenue);

    assert(
      c10.status === 200 && matchesB,
      'Dashboard de B coincide con SELECT directo de B y no mezcla totales de A',
      `API B count=${dashSalesB.total_sales_count}, DB B count=${bSalesDb[0].count}, DB A count=${aSalesDb[0].count}`
    );

    console.log('--- Caso 1d: Los pagos de B no aparecen en el dashboard de A (RF-24) ---');
    const c10A = await request('/dashboard', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const dashPaymentsA = c10A.data?.data?.sales?.revenue_by_payment_method || [];
    const totalPaymentsRevenueA = dashPaymentsA.reduce((sum, p) => sum + Number(p.revenue), 0);

    const { rows: aPaymentsDb } = await pool.query(
      `SELECT COALESCE(SUM(sp.amount), 0)::NUMERIC AS revenue
       FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
       WHERE sp.company_id = $1 AND s.status = 'completed' AND s.created_at >= $2 AND s.created_at <= $3`,
      [companyAId, c10A.data?.data?.sales?.period?.from, c10A.data?.data?.sales?.period?.to]
    );

    const { rows: bPaymentsInADb } = await pool.query(
      `SELECT COUNT(*)::INTEGER AS count
       FROM sale_payments sp
       WHERE sp.company_id = $1 AND sp.sale_id IN (SELECT id FROM sales WHERE company_id = $2)`,
      [companyAId, companyBId]
    );

    assert(
      c10A.status === 200 &&
        Number(totalPaymentsRevenueA) === Number(aPaymentsDb[0].revenue) &&
        Number(bPaymentsInADb[0].count) === 0,
      'Los pagos de B no aparecen en el dashboard de A',
      `Dash A revenue=${totalPaymentsRevenueA}, DB A revenue=${aPaymentsDb[0].revenue}, Cross-payments=${bPaymentsInADb[0].count}`
    );

    console.log('--- Caso 11: Usuario de empresa inactiva (is_active = false) intenta login -> 403 ---');
    await pool.query(`UPDATE companies SET is_active = false WHERE id = $1`, [companyBId]);
    const c11 = await request('/auth/login', {
      method: 'POST',
      body: { email: companyB.adminEmail, password: companyB.adminPassword },
    });
    assert(
      c11.status === 403 && c11.data?.error?.code === 'COMPANY_INACTIVE',
      'Login bloqueado con 403 COMPANY_INACTIVE cuando is_active = false',
      `status: ${c11.status}, code: ${c11.data?.error?.code}`
    );
    await pool.query(`UPDATE companies SET is_active = true WHERE id = $1`, [companyBId]);

    console.log('--- Caso 12: Usuario de empresa suspendida (status = suspended) intenta login -> 403 ---');
    await pool.query(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [companyBId]);
    const c12 = await request('/auth/login', {
      method: 'POST',
      body: { email: companyB.adminEmail, password: companyB.adminPassword },
    });
    assert(
      c12.status === 403 && c12.data?.error?.code === 'COMPANY_INACTIVE',
      'Login bloqueado con 403 COMPANY_INACTIVE cuando status = suspended',
      `status: ${c12.status}, code: ${c12.data?.error?.code}`
    );
    await pool.query(`UPDATE companies SET status = 'active' WHERE id = $1`, [companyBId]);

    console.log('--- Caso 13: Aislamiento y permisos en /api/company ---');
    // 13a: Admin B consulta configuración -> ve solo su empresa
    const c13a = await request('/company', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(
      c13a.status === 200 && c13a.data?.data?.id === companyBId,
      'Admin de B ve solo los datos de configuración de su propia empresa',
      `status: ${c13a.status}, id: ${c13a.data?.data?.id}`
    );

    // 13b: Admin B intenta actualizar con RUC inválido -> 422
    const c13b = await request('/company', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { ruc: '123456' },
    });
    assert(
      c13b.status === 422,
      'PUT /api/company rechaza RUC inválido con status 422',
      `status: ${c13b.status}`
    );

    // 13c: Mecánico de B intenta actualizar configuración -> 403 Forbidden
    const loginMecB = await request('/auth/login', {
      method: 'POST',
      body: { email: companyB.mechanicEmail, password: companyB.adminPassword },
    });
    const tokenMecB = loginMecB.data?.data?.token;
    const c13c = await request('/company', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenMecB}` },
      body: { nombre_comercial: 'Intento Hack Mecánico' },
    });
    assert(
      c13c.status === 403,
      'PUT /api/company rechaza usuario sin rol admin con status 403',
      `status: ${c13c.status}`
    );

    // 13d: Admin B actualiza nombre comercial exitosamente -> 200
    const c13d = await request('/company', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { nombre_comercial: '[PRUEBA] B Express' },
    });
    assert(
      c13d.status === 200 && c13d.data?.data?.nombre_comercial === '[PRUEBA] B Express',
      'Admin de B actualiza con éxito su configuración',
      `status: ${c13d.status}`
    );

    // 13e: Admin A consulta su configuración -> sus datos permanecen intactos
    const c13e = await request('/company', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(
      c13e.status === 200 &&
        c13e.data?.data?.id === companyAId &&
        c13e.data?.data?.nombre_comercial !== '[PRUEBA] B Express',
      'Configuración de Empresa A permanece aislada e intacta tras cambios en B',
      `status: ${c13e.status}, id: ${c13e.data?.data?.id}`
    );

    // -------------------------------------------------------------------------
    // Caso 14: Aislamiento estricto en gestión de usuarios (/api/users)
    // Admin de B no puede listar, editar, desactivar ni resetear usuarios de A
    // -------------------------------------------------------------------------
    console.log('--- Caso 14: Aislamiento en gestión de usuarios (/api/users) ---');
    const userAId = companyA.mechanicId;

    // 14a: B intenta GET /api/users/:user_id_de_A -> 404
    const c14a = await request(`/users/${userAId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(
      c14a.status === 404,
      'Admin de B no puede ver usuario de Empresa A (GET /api/users/:id -> 404)',
      `status: ${c14a.status}`
    );

    // 14b: B intenta PATCH /api/users/:user_id_de_A -> 404
    const c14b = await request(`/users/${userAId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { name: 'Nombre Hackeado Por B' },
    });
    assert(
      c14b.status === 404,
      'Admin de B no puede modificar usuario de Empresa A (PATCH /api/users/:id -> 404)',
      `status: ${c14b.status}`
    );

    // 14c: B intenta DELETE /api/users/:user_id_de_A -> 404
    const c14c = await request(`/users/${userAId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(
      c14c.status === 404,
      'Admin de B no puede desactivar usuario de Empresa A (DELETE /api/users/:id -> 404)',
      `status: ${c14c.status}`
    );

    // 14d: B intenta POST /api/users/:user_id_de_A/reset-password -> 404
    const c14d = await request(`/users/${userAId}/reset-password`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { new_password: 'NuevaPassword123' },
    });
    assert(
      c14d.status === 404,
      'Admin de B no puede resetear contraseña de usuario de Empresa A (POST /api/users/:id/reset-password -> 404)',
      `status: ${c14d.status}`
    );

    // 14e: B lista usuarios (GET /api/users) -> ningún usuario pertenece a la Empresa A
    const c14e = await request('/users', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const usersOfB = c14e.data?.data || [];
    const containsUserOfA = usersOfB.some((u) => Number(u.id) === Number(userAId) || Number(u.id) === Number(companyA.adminId));
    assert(
      c14e.status === 200 && !containsUserOfA,
      'Listado de usuarios de B no contiene ningún usuario perteneciente a la Empresa A',
      `status: ${c14e.status}, total_users_b: ${usersOfB.length}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 15: Aislamiento en Consulta de Auditoría (/api/audit)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 15: Aislamiento en Consulta de Auditoría (/api/audit) ---');

    // 15a: Generar un log en Empresa A actualizando su producto
    await request(`/inventory/${companyA.productId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { sale_price: 99.50 },
    });

    // 15b: Admin B consulta los logs filtrando por el product_id de A -> debe devolver 0 logs
    const c15a = await request(`/audit?entity=product&entity_id=${companyA.productId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const logsEntityAFromB = c15a.data?.data?.logs || [];
    assert(
      c15a.status === 200 && logsEntityAFromB.length === 0,
      'Admin de B no puede ver logs de un producto de la Empresa A (responde 0 logs)',
      `status: ${c15a.status}, logs: ${logsEntityAFromB.length}`
    );

    // 15c: Admin B consulta todos los logs de su empresa -> ninguno pertenece a la empresa A
    const { rows: auditRowsA } = await pool.query(
      'SELECT id FROM audit_logs WHERE company_id = $1',
      [companyAId]
    );
    const auditIdsA = new Set(auditRowsA.map((r) => Number(r.id)));

    const c15b = await request('/audit', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const logsOfB = c15b.data?.data?.logs || [];
    const containsLogOfA = logsOfB.some((l) => auditIdsA.has(Number(l.id)) || Number(l.company_id) === Number(companyAId));

    assert(
      c15b.status === 200 && !containsLogOfA,
      'Listado de auditoría de B no contiene ningún registro perteneciente a la Empresa A',
      `status: ${c15b.status}, total_logs_b: ${logsOfB.length}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 16: Aislamiento del Onboarding (/api/auth/register-company)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 16: Aislamiento de taller registrado vía Onboarding ---');
    const c16Email = `taller.isolation.${Date.now()}@mototrack.local`;
    const rRegisterC = await request('/auth/register-company', {
      method: 'POST',
      body: {
        razon_social: '[PRUEBA] Taller C Aislamiento',
        admin_name: 'Admin Taller C',
        email: c16Email,
        password: 'Password123!',
        accept_terms: true,
      },
    });

    assert(rRegisterC.status === 201, 'Taller C registrado exitosamente vía onboarding (201)');
    const tokenC = rRegisterC.data?.data?.token;
    const companyCId = rRegisterC.data?.data?.user?.company_id;

    // C intenta leer el producto de A -> 404
    const rCReadA = await request(`/inventory/${companyA.productId}`, {
      headers: { Authorization: `Bearer ${tokenC}` },
    });
    assert(
      rCReadA.status === 404,
      'Nuevo taller C recibe 404 al intentar acceder a producto de Taller A'
    );

    // C intenta leer usuario de B -> 404
    const rCReadUserB = await request(`/users/${companyB.adminId}`, {
      headers: { Authorization: `Bearer ${tokenC}` },
    });
    assert(
      rCReadUserB.status === 404,
      'Nuevo taller C recibe 404 al intentar acceder a usuario de Taller B'
    );

    // Desactivar Taller C
    if (companyCId) {
      await pool.query(
        `UPDATE companies SET is_active = false WHERE id = $1 AND razon_social LIKE '[PRUEBA]%'`,
        [companyCId]
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 17: Aislamiento en consumo de plan (/api/company/plan)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 17: Aislamiento en consulta de plan (/api/company/plan) ---');

    // 17a: Insertar escaneo de prueba para Empresa A
    await pool.query(
      `INSERT INTO ai_usage (company_id, user_id, model, input_tokens, output_tokens, thinking_tokens, latency_ms, success, estimated_cost_usd)
       VALUES ($1, $2, 'gemini-3.5-flash-lite', 500, 100, 0, 1200, true, 0.0004)`,
      [companyAId, companyA.adminId]
    );

    // 17b: Admin B consulta GET /api/company/plan
    const c17 = await request('/company/plan', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    const { rows: countUsersB } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM users WHERE company_id = $1 AND is_active = true`,
      [companyBId]
    );
    const { rows: countScansB } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ai_usage WHERE company_id = $1 AND success = true`,
      [companyBId]
    );

    const bPlanData = c17.data?.data;
    assert(
      c17.status === 200 &&
      bPlanData?.users_active === countUsersB[0].count &&
      bPlanData?.ai_scans_this_month === countScansB[0].count,
      'El uso de B no cuenta escaneos ni usuarios de A (/api/company/plan aislado)',
      `users_b: ${bPlanData?.users_active}, scans_b: ${bPlanData?.ai_scans_this_month}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 18: Aislamiento en Notas de Crédito (/api/invoicing/credit-notes) ---');

    // 18a: Crear una venta y boleta aceptada en Empresa A
    const { rows: saleARows } = await pool.query(
      `INSERT INTO sales (company_id, total, subtotal, igv, igv_rate, payment_method, status, customer_name)
       VALUES ($1, 50.00, 42.37, 7.63, 0.18, 'efectivo', 'completed', '[PRUEBA] Cliente NC A')
       RETURNING id`,
      [companyAId]
    );
    const saleAId = saleARows[0].id;
    await pool.query(
      `INSERT INTO sale_payments (company_id, sale_id, method, amount)
       VALUES ($1, $2, 'efectivo', 50.00)`,
      [companyAId, saleAId]
    );
    const { rows: invARows } = await pool.query(
      `INSERT INTO invoices (company_id, sale_id, comprobante_type, serie, numero, estado, xml_content)
       VALUES ($1, $2, 'boleta', 'B001', 999, 'accepted', '<xml>test</xml>')
       RETURNING id`,
      [companyAId, saleAId]
    );
    const invAId = invARows[0].id;

    // 18b: Anular la venta con voidSale en Empresa A (genera NC en A)
    const voidRes = await request(`/sales/${saleAId}/void`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { void_reason: 'Anulación de prueba para aislamiento', motivo_code: '01' },
    });
    const ncA = voidRes.data?.data?.credit_note;
    assert(
      voidRes.status === 200 && ncA?.id != null,
      'Empresa A anula su venta y genera Nota de Crédito en A',
      `status: ${voidRes.status}, nc_id: ${ncA?.id}`
    );

    // 18c: Empresa B lista notas de crédito -> la NC de A NO debe aparecer
    const listBRes = await request('/invoicing/credit-notes', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const bCreditNotes = listBRes.data?.data ?? [];
    const ncAInB = bCreditNotes.some((nc) => nc.id === ncA.id || nc.company_id === companyAId);
    assert(
      listBRes.status === 200 && !ncAInB,
      'Empresa B no ve la Nota de Crédito de Empresa A en su listado (/api/invoicing/credit-notes)',
      `total_b: ${bCreditNotes.length}`
    );

    // 18d: Empresa B intenta ver el ticket de la NC de A -> 404
    const ticketBRes = await request(`/invoicing/credit-notes/${ncA.id}/ticket`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(
      ticketBRes.status === 404,
      'Empresa B no puede ver el ticket de la NC de Empresa A (retorna 404)',
      `status: ${ticketBRes.status}`
    );

    // 18e: Empresa B intenta reintentar la NC de A -> 404
    const retryBRes = await request(`/invoicing/credit-notes/${ncA.id}/retry`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(
      retryBRes.status === 404,
      'Empresa B no puede reintentar la NC de Empresa A (retorna 404)',
      `status: ${retryBRes.status}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // CASO 19: AISLAMIENTO EN ALERTAS Y ALTERNATIVAS (RF-06, RF-21)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 19: Aislamiento en /inventory/alerts y /inventory/:id/alternatives ---');

    // 19a: Empresa B consulta /inventory/alerts -> no debe mostrar productos de Empresa A
    const alertsBRes = await request('/inventory/alerts', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const bAlerts = alertsBRes.data?.data || { out_of_stock: [], low_stock: [] };
    const allBAlertItems = [...(bAlerts.out_of_stock || []), ...(bAlerts.low_stock || [])];
    const hasAInAlertsB = allBAlertItems.some((item) => item.id === companyA.productId);
    assert(
      alertsBRes.status === 200 && !hasAInAlertsB,
      'Empresa B no ve productos de Empresa A en sus alertas de stock (/api/inventory/alerts)',
      `status: ${alertsBRes.status}`
    );

    // 19b: Empresa B consulta alternativas para el producto de Empresa A -> 404
    const altProductARes = await request(`/inventory/${companyA.productId}/alternatives`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(
      altProductARes.status === 404,
      'Empresa B no puede consultar alternativas de un producto de Empresa A (retorna 404)',
      `status: ${altProductARes.status}`
    );

    // 19c: Empresa B consulta alternativas para su propio producto -> ninguna alternativa es de Empresa A
    const altProductBRes = await request(`/inventory/${companyB.productId}/alternatives`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const bAlternatives = altProductBRes.data?.data || [];
    const hasAInAltsB = bAlternatives.some((alt) => alt.id === companyA.productId);
    assert(
      altProductBRes.status === 200 && !hasAInAltsB,
      'Las alternativas del producto de Empresa B nunca incluyen productos de Empresa A',
      `status: ${altProductBRes.status}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // VERIFICACIÓN FINAL: EMPRESA REAL INTACTA
    // ─────────────────────────────────────────────────────────────────────────
    if (realCompanyId && initialRealCounts) {
      console.log('--- Verificación Final: Integridad de Taller Principal ---');
      const finalRealCounts = await getRealCompanyCounts(realCompanyId);
      console.log(
        `  Taller Principal - Antes  : ${initialRealCounts.sales} ventas, ${initialRealCounts.invoices} facturas, ${initialRealCounts.workOrders} OT`
      );
      console.log(
        `  Taller Principal - Después: ${finalRealCounts.sales} ventas, ${finalRealCounts.invoices} facturas, ${finalRealCounts.workOrders} OT`
      );

      const unchanged =
        initialRealCounts.sales === finalRealCounts.sales &&
        initialRealCounts.invoices === finalRealCounts.invoices &&
        initialRealCounts.workOrders === finalRealCounts.workOrders;

      assert(
        unchanged,
        'Los conteos de Taller Principal (empresa real) no sufrieron ningún cambio tras la suite'
      );
    }

  } catch (err) {
    console.error('💥  Error inesperado durante la ejecución de las pruebas:', err);
    failedTests++;
  } finally {
    // 3. Desactivar ambas empresas de prueba (is_active = false)
    if (companyAId && companyBId) {
      try {
        await pool.query(
          `UPDATE companies SET is_active = false WHERE id IN ($1, $2)`,
          [companyAId, companyBId]
        );
        console.log(
          `\n🧹  Limpieza: Empresas de prueba id=${companyAId} y id=${companyBId} desactivadas lógicamente (is_active = false).`
        );
      } catch (cleanErr) {
        console.error('Error al desactivar empresas de prueba:', cleanErr.message);
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
    console.log('✅  TODAS LAS PRUEBAS DE AISLAMIENTO MULTI-TENANT PASARON CON ÉXITO.');
    console.log('===============================================================\n');
    process.exit(0);
  }
}

run();
