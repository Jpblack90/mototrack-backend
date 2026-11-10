// =============================================================================
// scripts/tests/verify-14-2.js
// Suite de verificación Tarea 14.2a: Entrada de mercadería al inventario
//
// Reglas:
// 1. POST /api/inventory/:id/stock-entry · authorize('admin','cajero','almacenero')
// 2. Almacenero A suma 5 → stock +5 y existe el registro en audit_logs.
// 3. quantity 0, -3, 2.5 y "abc" → 422 (el stock no cambia).
// 4. Producto de Empresa B → 404 (aislamiento multi-tenant).
// 5. Mecánico A → 403 (RBAC).
// 6. Dos entradas seguidas (3 y 4) → stock +7 exacto.
// 7. Limpieza y empresas [PRUEBA] inactivas al final (regla 8).
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
  console.log('🧪  INICIANDO SUITE VERIFY-14-2: ENTRADA DE MERCADERÍA (ALMACÉN)');
  console.log('===============================================================\n');

  let companyA = null;
  let companyB = null;
  const createdProductIds = [];

  try {
    // 1. Seed base
    const seed = await seedTestCompany();
    companyA = seed.companyA;
    companyB = seed.companyB;

    // Reactivar empresas y usuarios de prueba
    await pool.query('UPDATE companies SET is_active = true WHERE id IN ($1, $2)', [
      companyA.companyId,
      companyB.companyId,
    ]);
    await pool.query('UPDATE users SET is_active = true WHERE company_id IN ($1, $2)', [
      companyA.companyId,
      companyB.companyId,
    ]);

    const tokenAlmaceneroA = makeToken({
      id: companyA.almaceneroId,
      email: companyA.almaceneroEmail,
      role: 'almacenero',
      company_id: companyA.companyId,
    });

    const tokenMechanicA = makeToken({
      id: companyA.mechanicId,
      email: companyA.mechanicEmail,
      role: 'mecanico',
      company_id: companyA.companyId,
    });

    // Crear producto de prueba específico en Empresa A
    const { rows: [prodA] } = await pool.query(
      `INSERT INTO products (company_id, name, sku, brand, category, cost_price, sale_price, stock, min_stock, is_active)
       VALUES ($1, '[PRUEBA] Filtro Aceite 14-2', 'PRUEBA-SKU-14-2', 'Honda', 'Filtros', 15.00, 25.00, 10, 5, true)
       RETURNING *`,
      [companyA.companyId]
    );
    createdProductIds.push(prodA.id);

    // ─── CASO 1: Almacenero A suma 5 → stock +5 y existe registro en audit_logs ────────────────
    console.log('\n--- Caso 1: Almacenero A suma 5 unidades con nota ---');
    const resEntry5 = await request(`/inventory/${prodA.id}/stock-entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlmaceneroA}` },
      body: { quantity: 5, note: 'Lote de reposición mensual' },
    });

    const { rows: [prodAAfter5] } = await pool.query('SELECT stock FROM products WHERE id = $1', [prodA.id]);
    const { rows: [auditEntry] } = await pool.query(
      `SELECT * FROM audit_logs
       WHERE company_id = $1 AND entity = 'product' AND entity_id = $2 AND action = 'stock_entry'
       ORDER BY id DESC LIMIT 1`,
      [companyA.companyId, prodA.id]
    );

    const auditChanges = typeof auditEntry?.changes === 'string'
      ? JSON.parse(auditEntry.changes)
      : auditEntry?.changes;

    assert(
      resEntry5.status === 200 &&
        resEntry5.data?.data?.stock === 15 &&
        Number(prodAAfter5.stock) === 15,
      'Almacenero A suma 5 → stock 10 pasa a 15 (+5)',
      resEntry5
    );

    assert(
      auditEntry != null &&
        auditChanges?.stock?.old === 10 &&
        auditChanges?.stock?.new === 15 &&
        auditChanges?.quantity === 5 &&
        auditChanges?.note === 'Lote de reposición mensual' &&
        Number(auditEntry.user_id) === Number(companyA.almaceneroId),
      'audit_logs registra la acción "stock_entry" con antes/después, cantidad, nota y user_id',
      auditChanges
    );

    // ─── CASO 2: Validaciones de quantity (0, -3, 2.5, "abc") → 422 (stock no cambia) ─────────
    console.log('\n--- Caso 2: Validaciones de quantity inválido (422) ---');

    // 2.1 quantity = 0
    const resQ0 = await request(`/inventory/${prodA.id}/stock-entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlmaceneroA}` },
      body: { quantity: 0 },
    });
    // 2.2 quantity = -3
    const resQNeg = await request(`/inventory/${prodA.id}/stock-entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlmaceneroA}` },
      body: { quantity: -3 },
    });
    // 2.3 quantity = 2.5
    const resQFloat = await request(`/inventory/${prodA.id}/stock-entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlmaceneroA}` },
      body: { quantity: 2.5 },
    });
    // 2.4 quantity = "abc"
    const resQStr = await request(`/inventory/${prodA.id}/stock-entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlmaceneroA}` },
      body: { quantity: 'abc' },
    });

    const { rows: [prodAUnchanged] } = await pool.query('SELECT stock FROM products WHERE id = $1', [prodA.id]);

    assert(
      resQ0.status === 422 &&
        resQNeg.status === 422 &&
        resQFloat.status === 422 &&
        resQStr.status === 422 &&
        Number(prodAUnchanged.stock) === 15,
      'quantity 0, -3, 2.5 y "abc" → 422 (el stock no cambia y se mantiene en 15)',
      { q0: resQ0.status, qNeg: resQNeg.status, qFloat: resQFloat.status, qStr: resQStr.status }
    );

    // ─── CASO 3: Producto de Empresa B → 404 ───────────────────────────────────────────────────
    console.log('\n--- Caso 3: Aislamiento multi-tenant (Empresa B) ---');
    const { rows: [prodB] } = await pool.query(
      `INSERT INTO products (company_id, name, sku, brand, category, cost_price, sale_price, stock, min_stock, is_active)
       VALUES ($1, '[PRUEBA] Producto Empresa B', 'PRUEBA-SKU-B-14-2', 'Bajaj', 'Frenos', 20.00, 35.00, 10, 5, true)
       RETURNING *`,
      [companyB.companyId]
    );
    createdProductIds.push(prodB.id);

    const resProdB = await request(`/inventory/${prodB.id}/stock-entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlmaceneroA}` },
      body: { quantity: 5 },
    });

    assert(
      resProdB.status === 404 && resProdB.data?.error?.code === 'PRODUCT_NOT_FOUND',
      'Almacenero A intentando stock-entry en producto de Empresa B → 404 PRODUCT_NOT_FOUND',
      resProdB
    );

    // ─── CASO 4: Mecánico A intentando stock-entry → 403 ──────────────────────────────────────
    console.log('\n--- Caso 4: Control de acceso por rol (Mecánico → 403) ---');
    const resMech = await request(`/inventory/${prodA.id}/stock-entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenMechanicA}` },
      body: { quantity: 5 },
    });

    assert(
      resMech.status === 403,
      'Mecánico A intentando registrar entrada de mercadería → 403 FORBIDDEN',
      resMech
    );

    // ─── CASO 5: Dos entradas seguidas (3 y 4) → stock +7 exacto ──────────────────────────────
    console.log('\n--- Caso 5: Dos entradas consecutivas (3 y 4) ---');
    const resEntry3 = await request(`/inventory/${prodA.id}/stock-entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlmaceneroA}` },
      body: { quantity: 3, note: 'Primera remesa' },
    });
    const resEntry4 = await request(`/inventory/${prodA.id}/stock-entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlmaceneroA}` },
      body: { quantity: 4, note: 'Segunda remesa' },
    });

    const { rows: [prodAFinal] } = await pool.query('SELECT stock FROM products WHERE id = $1', [prodA.id]);

    assert(
      resEntry3.status === 200 &&
        resEntry4.status === 200 &&
        resEntry3.data?.data?.stock === 18 &&
        resEntry4.data?.data?.stock === 22 &&
        Number(prodAFinal.stock) === 22,
      'Dos entradas seguidas (3 y 4) sobre stock 15 → stock 22 (+7 exacto)',
      { after3: resEntry3.data?.data?.stock, after4: resEntry4.data?.data?.stock, finalStock: prodAFinal.stock }
    );

  } catch (err) {
    console.error('❌  Error inesperado durante verify-14-2:', err);
    failedTests++;
  } finally {
    // Limpieza de productos creados
    if (createdProductIds.length > 0) {
      await pool.query('DELETE FROM products WHERE id = ANY($1::int[])', [createdProductIds]);
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
