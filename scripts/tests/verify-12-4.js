// =============================================================================
// scripts/tests/verify-12-4.js
// Verificación integral de la Tarea 12.4:
// - Comparación de modelos normalizada (JS y SQL con [^a-z0-9])
// - Filtro compatible_with y stock_status (low/out) en GET /api/inventory
// - Endpoint GET /api/inventory/alerts (con RBAC: mecánico -> 403)
// - Endpoint GET /api/inventory/:id/alternatives (priorización, sin categoría -> [])
// - stock_alerts en createSale (cruce de umbral para directos y componentes de kits)
// =============================================================================

import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';

if (process.env.NODE_ENV === 'production') {
  console.error('❌  Error: verify-12-4.js no debe ejecutarse en entorno de producción.');
  process.exit(1);
}

const API_BASE = process.env.API_URL || 'http://localhost:4000/api';
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

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

function makeToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      company_id: user.company_id,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
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
  return { status: res.status, data };
}

async function run() {
  console.log('\n===============================================================');
  console.log('🧪  INICIANDO SUITE VERIFY-12-4: ALERTAS, COMPATIBILIDAD Y ALTERNATIVAS');
  console.log('===============================================================\n');

  let companyA;
  let companyB;

  try {
    const seeded = await seedTestCompany();
    companyA = seeded.companyA;
    companyB = seeded.companyB;

    const { rows: cajRows } = await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active)
       VALUES ($1, 'Cajero A', $2, 'hash', 'cajero', true)
       ON CONFLICT (email) DO UPDATE SET role = 'cajero', is_active = true
       RETURNING id, email, role`,
      [companyA.companyId, `cajero.test.${companyA.companyId}@mototrack.local`]
    );
    const { rows: almRows } = await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active)
       VALUES ($1, 'Almacenero A', $2, 'hash', 'almacenero', true)
       ON CONFLICT (email) DO UPDATE SET role = 'almacenero', is_active = true
       RETURNING id, email, role`,
      [companyA.companyId, `almacenero.test.${companyA.companyId}@mototrack.local`]
    );

    const tokenAdminA = makeToken({ id: companyA.adminId, email: companyA.adminEmail, role: 'admin', company_id: companyA.companyId });
    const tokenCajeroA = makeToken({ id: cajRows[0].id, email: cajRows[0].email, role: 'cajero', company_id: companyA.companyId });
    const tokenAlmaceneroA = makeToken({ id: almRows[0].id, email: almRows[0].email, role: 'almacenero', company_id: companyA.companyId });
    const tokenMecanicoA = makeToken({ id: companyA.mechanicId, email: companyA.mechanicEmail, role: 'mecanico', company_id: companyA.companyId });
    const tokenAdminB = makeToken({ id: companyB.adminId, email: companyB.adminEmail, role: 'admin', company_id: companyB.companyId });

    // Limpiar transacciones y productos previos de la empresa de prueba A para garantizar determinismo
    await pool.query(`DELETE FROM credit_notes WHERE company_id = $1`, [companyA.companyId]);
    await pool.query(`DELETE FROM invoices WHERE company_id = $1`, [companyA.companyId]);
    await pool.query(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)`, [companyA.companyId]);
    await pool.query(`DELETE FROM sale_payments WHERE company_id = $1`, [companyA.companyId]);
    await pool.query(`DELETE FROM sales WHERE company_id = $1`, [companyA.companyId]);
    await pool.query(`DELETE FROM kit_items WHERE kit_id IN (SELECT id FROM kits WHERE company_id = $1)`, [companyA.companyId]);
    await pool.query(`DELETE FROM kits WHERE company_id = $1`, [companyA.companyId]);
    await pool.query(`DELETE FROM products WHERE company_id = $1`, [companyA.companyId]);

    // ─── 1. Crear productos de prueba en Empresa A ─────────────────────────────
    console.log('--- Caso 1: Normalización de modelos en GET /api/inventory?compatible_with ---');
    
    // Producto con "Honda CG125" en compatible_models
    const skuP1 = `TEST-CG125-${Date.now()}`;
    const { rows: [p1] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Filtro Honda CG125', 'Honda', 'Filtros', 10.00, 20.00, 15, 5, $3)
       RETURNING *`,
      [companyA.companyId, skuP1, ['Honda CG125', 'Yamaha YBR125']]
    );

    // Consulta con "HONDA CG.125"
    const resNorm1 = await request(`/inventory?compatible_with=${encodeURIComponent('HONDA CG.125')}`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const found1 = (resNorm1.data?.data || []).some(p => p.id === p1.id);
    assert(found1, 'compatible_with="HONDA CG.125" encuentra el producto guardado con "Honda CG125"');

    // Consulta con "honda cg-125"
    const resNorm2 = await request(`/inventory?compatible_with=${encodeURIComponent('honda cg-125')}`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const found2 = (resNorm2.data?.data || []).some(p => p.id === p1.id);
    assert(found2, 'compatible_with="honda cg-125" encuentra el producto guardado con "Honda CG125"');

    // Consulta con "Honda  CG125" (múltiples espacios)
    const resNorm3 = await request(`/inventory?compatible_with=${encodeURIComponent('Honda  CG125')}`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const found3 = (resNorm3.data?.data || []).some(p => p.id === p1.id);
    assert(found3, 'compatible_with="Honda  CG125" (espacios) encuentra el producto guardado con "Honda CG125"');

    // Producto con "Yamaha Ténéré 700" en compatible_models (prueba de acentos / unaccent)
    const skuTenere = `TEST-TENERE-${Date.now()}`;
    const { rows: [pTenere] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Parabrisas Ténéré', 'Yamaha', 'Accesorios', 80.00, 150.00, 5, 2, $3)
       RETURNING *`,
      [companyA.companyId, skuTenere, ['Yamaha Ténéré 700']]
    );

    // Consulta con "yamaha tenere 700" (sin acento)
    const resTenere = await request(`/inventory?compatible_with=${encodeURIComponent('yamaha tenere 700')}`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const foundTenere = (resTenere.data?.data || []).some(p => p.id === pTenere.id);
    assert(foundTenere, 'compatible_with="yamaha tenere 700" encuentra el producto guardado con "Yamaha Ténéré 700"');

    // ─── 2. Filtros stock_status=low y stock_status=out ───────────────────────
    console.log('\n--- Caso 2: Filtros stock_status=low y stock_status=out ---');

    // Creamos:
    // pLow: stock 3, min_stock 5 (0 < stock <= min_stock -> low)
    // pOut: stock 0, min_stock 5 (stock = 0 -> out)
    // pNormal: stock 10, min_stock 5 (stock > min_stock -> normal)
    const skuLow = `TEST-LOW-${Date.now()}`;
    const skuOut = `TEST-OUT-${Date.now()}`;
    const skuNorm = `TEST-NORM-${Date.now()}`;

    const { rows: [pLow] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Repuesto Stock Bajo', 'Genérico', 'Frenos', 15.00, 30.00, 3, 5, $3)
       RETURNING *`,
      [companyA.companyId, skuLow, ['Honda Wave']]
    );

    const { rows: [pOut] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Repuesto Agotado', 'Genérico', 'Frenos', 20.00, 40.00, 0, 5, $3)
       RETURNING *`,
      [companyA.companyId, skuOut, ['Honda Wave']]
    );

    const { rows: [pNormal] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Repuesto Normal', 'Genérico', 'Frenos', 25.00, 50.00, 10, 5, $3)
       RETURNING *`,
      [companyA.companyId, skuNorm, ['Honda Wave']]
    );

    const resLow = await request('/inventory?stock_status=low', {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const lowList = resLow.data?.data || [];
    assert(lowList.some(p => p.id === pLow.id), 'stock_status=low incluye el producto con stock bajo');
    assert(!lowList.some(p => p.id === pOut.id), 'stock_status=low NO incluye productos agotados (stock=0)');
    assert(!lowList.some(p => p.id === pNormal.id), 'stock_status=low NO incluye productos con stock normal');

    const resOut = await request('/inventory?stock_status=out', {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const outList = resOut.data?.data || [];
    assert(outList.some(p => p.id === pOut.id), 'stock_status=out incluye el producto agotado (stock=0)');
    assert(!outList.some(p => p.id === pLow.id), 'stock_status=out NO incluye productos con stock bajo (stock>0)');
    assert(!outList.some(p => p.id === pNormal.id), 'stock_status=out NO incluye productos con stock normal');

    // Combinación search + stock_status
    const resComb = await request(`/inventory?search=${encodeURIComponent(skuLow)}&stock_status=low`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const combList = resComb.data?.data || [];
    assert(combList.length === 1 && combList[0].id === pLow.id, 'search + stock_status=low devuelve exactamente el ítem filtrado');

    // ─── 3. Endpoint /api/inventory/alerts ────────────────────────────────────
    console.log('\n--- Caso 3: GET /api/inventory/alerts y RBAC ---');

    // Mecánico -> 403 Forbidden
    const resMecAlerts = await request('/inventory/alerts', {
      headers: { Authorization: `Bearer ${tokenMecanicoA}` },
    });
    assert(resMecAlerts.status === 403, 'Rol mecánico recibe 403 Forbidden al consultar /inventory/alerts');

    // Admin, Cajero y Almacenero -> 200 OK
    const resAdminAlerts = await request('/inventory/alerts', {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const resCajAlerts = await request('/inventory/alerts', {
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
    });
    const resAlmAlerts = await request('/inventory/alerts', {
      headers: { Authorization: `Bearer ${tokenAlmaceneroA}` },
    });

    assert(resAdminAlerts.status === 200, 'Rol admin accede con 200 a /inventory/alerts');
    assert(resCajAlerts.status === 200, 'Rol cajero accede con 200 a /inventory/alerts');
    assert(resAlmAlerts.status === 200, 'Rol almacenero accede con 200 a /inventory/alerts');

    // Conteo directo en BD
    const { rows: [dbOutCount] } = await pool.query(
      `SELECT count(*)::int AS count FROM products WHERE company_id = $1 AND is_active = true AND stock = 0`,
      [companyA.companyId]
    );
    const { rows: [dbLowCount] } = await pool.query(
      `SELECT count(*)::int AS count FROM products WHERE company_id = $1 AND is_active = true AND stock > 0 AND stock <= min_stock`,
      [companyA.companyId]
    );

    const alertsData = resAdminAlerts.data?.data;
    assert(alertsData.out_of_stock.length === dbOutCount.count, 'out_of_stock coincide exactamente con el conteo directo en BD');
    assert(alertsData.low_stock.length === dbLowCount.count, 'low_stock coincide exactamente con el conteo directo en BD');
    assert(alertsData.total_alerts === (dbOutCount.count + dbLowCount.count), 'total_alerts coincide con la suma de agotados y stock bajo');

    // ─── 4. Endpoint /api/inventory/:id/alternatives ─────────────────────────
    console.log('\n--- Caso 4: GET /api/inventory/:id/alternatives y reglas de ordenamiento ---');

    // Creamos alternativas en la categoría 'Frenos':
    // pAlt1: misma categoría 'Frenos', comparte 'Honda Wave' y 'Honda CG125', stock 8
    // pAlt2: misma categoría 'Frenos', comparte solo 'Honda Wave', stock 12
    // pAltOut: misma categoría 'Frenos', stock 0 (NO debe aparecer)
    // pAltB: empresa B (NUNCA debe aparecer)
    const skuAlt1 = `TEST-ALT1-${Date.now()}`;
    const skuAlt2 = `TEST-ALT2-${Date.now()}`;
    const skuAltOut = `TEST-ALTOUT-${Date.now()}`;
    const skuAltB = `TEST-ALTB-${Date.now()}`;

    const { rows: [pAlt1] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Pastillas Brembo Wave y CG125', 'Brembo', 'Frenos', 30.00, 60.00, 8, 5, $3)
       RETURNING *`,
      [companyA.companyId, skuAlt1, ['Honda Wave', 'Honda CG125']]
    );

    const { rows: [pAlt2] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Pastillas EBC solo Wave', 'EBC', 'Frenos', 25.00, 50.00, 12, 5, $3)
       RETURNING *`,
      [companyA.companyId, skuAlt2, ['Honda Wave']]
    );

    const { rows: [pAltOut] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Pastillas Nissin Agotadas', 'Nissin', 'Frenos', 35.00, 70.00, 0, 5, $3)
       RETURNING *`,
      [companyA.companyId, skuAltOut, ['Honda Wave']]
    );

    const { rows: [pAltB] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Pastillas Empresa B', 'Brembo', 'Frenos', 30.00, 60.00, 20, 5, $3)
       RETURNING *`,
      [companyB.companyId, skuAltB, ['Honda Wave']]
    );

    // Consulta alternativas para pOut (categoría 'Frenos', modelos: ['Honda Wave'])
    const resAlts = await request(`/inventory/${pOut.id}/alternatives`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const alts = resAlts.data?.data || [];

    assert(!alts.some(a => a.id === pOut.id), 'alternatives NO incluye el propio producto consultado');
    assert(!alts.some(a => a.stock <= 0), 'alternatives NO incluye productos con stock 0');
    assert(!alts.some(a => a.id === pAltB.id), 'alternatives NUNCA devuelve productos de otra empresa');
    assert(alts.length <= 5, 'alternatives devuelve como máximo 5 productos');

    // Consulta con ?compatible_with="honda cg125"
    const resAltsMoto = await request(`/inventory/${pOut.id}/alternatives?compatible_with=${encodeURIComponent('honda cg-125')}`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const altsMoto = resAltsMoto.data?.data || [];
    assert(altsMoto.length > 0 && altsMoto[0].id === pAlt1.id, 'Prioriza la alternativa compatible con la moto del cliente (Honda CG125)');
    assert(altsMoto.every(a => typeof a.is_compatible === 'boolean'), 'Cada alternativa incluye is_compatible: true/false cuando se pasa compatible_with');
    assert(altsMoto.find(a => a.id === pAlt1.id)?.is_compatible === true, 'Alternativa para CG125 devuelve is_compatible = true');
    assert(altsMoto.find(a => a.id === pAlt2.id)?.is_compatible === false, 'Alternativa que no tiene CG125 devuelve is_compatible = false');

    // ─── 4b. Producto original sin categoría (NULL) ───────────────────────────
    console.log('\n--- Caso 4b: Producto original sin categoría (NULL) ---');
    // Subcaso A: tiene modelos compatibles -> busca por modelos compartidos
    const skuNoCatWithModels = `TEST-NOCAT-MOD-${Date.now()}`;
    const { rows: [pNoCatWithModels] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Sin Categoría Con Modelos', 'Genérico', NULL, 10.00, 20.00, 0, 5, $3)
       RETURNING *`,
      [companyA.companyId, skuNoCatWithModels, ['Honda Wave']]
    );

    const resNoCat1 = await request(`/inventory/${pNoCatWithModels.id}/alternatives`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const noCatAlts1 = resNoCat1.data?.data || [];
    assert(noCatAlts1.length > 0 && noCatAlts1.some(a => a.id === pAlt1.id), 'Producto sin categoría pero con modelos devuelve alternativas que comparten modelos');

    // Subcaso B: sin categoría y sin modelos compatibles -> lista vacía (no inventa)
    const skuNoCatNoModels = `TEST-NOCAT-NOMOD-${Date.now()}`;
    const { rows: [pNoCatNoModels] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, compatible_models)
       VALUES ($1, $2, '[PRUEBA] Sin Categoría Sin Modelos', 'Genérico', NULL, 10.00, 20.00, 0, 5, $3)
       RETURNING *`,
      [companyA.companyId, skuNoCatNoModels, []]
    );

    const resNoCat2 = await request(`/inventory/${pNoCatNoModels.id}/alternatives`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const noCatAlts2 = resNoCat2.data?.data || [];
    assert(Array.isArray(noCatAlts2) && noCatAlts2.length === 0, 'Producto sin categoría y sin modelos compatibles devuelve lista vacía []');

    // ─── 5. stock_alerts en createSale ────────────────────────────────────────
    console.log('\n--- Caso 5: stock_alerts en createSale (cruce de umbral) ---');

    // Producto pThreshold: stock 6, min_stock 5.
    // Al vender 2 unidades -> stock queda en 4 (cruza de 6 a 4, <= 5) -> DEBE alertar
    const skuThresh = `TEST-THRESH-${Date.now()}`;
    const { rows: [pThresh] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock)
       VALUES ($1, $2, '[PRUEBA] Producto Cruce Umbral', 'Marca', 'Filtros', 10.00, 20.00, 6, 5)
       RETURNING *`,
      [companyA.companyId, skuThresh]
    );

    const saleRes1 = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        payment_method: 'efectivo',
        items: [{ product_id: pThresh.id, quantity: 2 }],
      },
    });

    assert(saleRes1.status === 201, 'Venta 1 se crea exitosamente');
    const alerts1 = saleRes1.data?.data?.stock_alerts || [];
    assert(alerts1.some(a => a.id === pThresh.id), 'Venta que cruza el umbral (6 -> 4 con mín 5) incluye el producto en stock_alerts');

    // Venta 2 del mismo producto: pasa de 4 a 3 (ya estaba por debajo de 5) -> NO debe alertar
    const saleRes2 = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        payment_method: 'efectivo',
        items: [{ product_id: pThresh.id, quantity: 1 }],
      },
    });

    assert(saleRes2.status === 201, 'Venta 2 se crea exitosamente');
    const alerts2 = saleRes2.data?.data?.stock_alerts || [];
    assert(!alerts2.some(a => a.id === pThresh.id), 'Venta posterior de un producto que ya estaba bajo NO lo repite en stock_alerts');

    // ─── 5b. Cruce de umbral en componentes de un Kit ─────────────────────────
    console.log('\n--- Caso 5b: Cruce de umbral en componente de Kit ---');

    const skuComp = `TEST-KITCOMP-${Date.now()}`;
    const { rows: [pComp] } = await pool.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock)
       VALUES ($1, $2, '[PRUEBA] Componente de Kit', 'Marca', 'Motor', 15.00, 30.00, 7, 5)
       RETURNING *`,
      [companyA.companyId, skuComp]
    );

    const { rows: [kit] } = await pool.query(
      `INSERT INTO kits (company_id, name, description, kit_price)
       VALUES ($1, '[PRUEBA] Kit Mantenimiento', 'Kit de prueba', 45.00)
       RETURNING *`,
      [companyA.companyId]
    );

    // Kit usa 3 unidades de pComp. Al vender 1 kit, pComp pasa de 7 a 4 (min_stock 5) -> cruza umbral
    await pool.query(
      `INSERT INTO kit_items (kit_id, product_id, quantity) VALUES ($1, $2, 3)`,
      [kit.id, pComp.id]
    );

    const saleKitRes = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        payment_method: 'efectivo',
        items: [{ kit_id: kit.id, quantity: 1 }],
      },
    });

    assert(saleKitRes.status === 201, 'Venta de kit se crea exitosamente');
    const kitAlerts = saleKitRes.data?.data?.stock_alerts || [];
    assert(kitAlerts.some(a => a.id === pComp.id), 'Componente de kit que cruza el umbral de stock se incluye en stock_alerts');

  } catch (err) {
    console.error('💥 Error inesperado durante la ejecución:', err);
    failedTests++;
  } finally {
    // Desactivar todos los productos de prueba creados en la suite (Regla 8)
    if (companyA?.companyId && companyB?.companyId) {
      await pool.query(
        `UPDATE products SET is_active = false WHERE company_id IN ($1, $2) AND (sku LIKE 'TEST-%' OR name LIKE '[PRUEBA]%')`,
        [companyA.companyId, companyB.companyId]
      );
    }
    // Limpieza lógica de empresas de prueba
    if (companyA?.companyId) {
      await pool.query('UPDATE companies SET is_active = false WHERE id = $1', [companyA.companyId]);
    }
    if (companyB?.companyId) {
      await pool.query('UPDATE companies SET is_active = false WHERE id = $1', [companyB.companyId]);
    }
    console.log('\n🧹  Limpieza completada: Empresas y productos de prueba desactivados (Regla 8).');
    await pool.end();
  }

  console.log('\n===============================================================');
  console.log(`📊  RESULTADOS: ${passedTests}/${totalTests} pruebas pasaron.`);
  if (failedTests > 0) {
    console.log(`❌  ${failedTests} prueba(s) fallaron.`);
    console.log('===============================================================\n');
    process.exit(1);
  } else {
    console.log('✅  TODAS LAS PRUEBAS DE LA TAREA 12.4 PASARON CON ÉXITO.');
    console.log('===============================================================\n');
    process.exit(0);
  }
}

run();
