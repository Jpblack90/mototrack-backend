// =============================================================================
// scripts/tests/verify-11-4.js
// Suite de verificación integral de la Tarea 11.4:
// Sistema de Auditoría Inmutable Multi-Tenant (RF-09).
// Solo opera con empresas de prueba [PRUEBA].
// =============================================================================

import 'dotenv/config';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';

if (process.env.NODE_ENV === 'production') {
  console.error('❌  Error: verify-11-4.js no debe ejecutarse en entorno de producción.');
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
    // respuesta sin cuerpo JSON
  }

  return { status: res.status, ok: res.ok, data };
}

async function run() {
  console.log('\n===============================================================');
  console.log('🚀  VERIFICACIÓN INTEGRAL: TAREA 11.4 (AUDITORÍA INMUTABLE)');
  console.log('===============================================================\n');

  let companyAId, companyBId;
  let tokenAdminA, tokenAdminB, tokenCajeroA;
  let initialRealCounts;

  try {
    // 0. Conteo inicial de "Taller Principal" para verificar que no sea tocado
    const { rows: realCo } = await pool.query(
      `SELECT id FROM companies WHERE razon_social = 'Taller Principal'`
    );
    const realCompanyId = realCo[0]?.id;
    if (realCompanyId) {
      const { rows: realSales } = await pool.query('SELECT COUNT(*)::int AS count FROM sales WHERE company_id = $1', [realCompanyId]);
      const { rows: realInvoices } = await pool.query('SELECT COUNT(*)::int AS count FROM invoices WHERE company_id = $1', [realCompanyId]);
      const { rows: realWorkorders } = await pool.query('SELECT COUNT(*)::int AS count FROM work_orders WHERE company_id = $1', [realCompanyId]);
      const { rows: realAudits } = await pool.query('SELECT COUNT(*)::int AS count FROM audit_logs WHERE company_id = $1', [realCompanyId]);
      initialRealCounts = {
        sales: realSales[0].count,
        invoices: realInvoices[0].count,
        workorders: realWorkorders[0].count,
        audits: realAudits[0].count,
      };
    }

    // 1. Preparar empresas de prueba A y B
    const { companyA, companyB } = await seedTestCompany();
    companyAId = companyA.companyId;
    companyBId = companyB.companyId;

    // Login Admin A
    const loginA = await request('/auth/login', {
      method: 'POST',
      body: { email: companyA.adminEmail, password: companyA.adminPassword },
    });
    if (!loginA.ok) throw new Error(`Login de Admin A falló: ${JSON.stringify(loginA.data)}`);
    tokenAdminA = loginA.data.data.token;

    // Login Admin B
    const loginB = await request('/auth/login', {
      method: 'POST',
      body: { email: companyB.adminEmail, password: companyB.adminPassword },
    });
    if (!loginB.ok) throw new Error(`Login de Admin B falló: ${JSON.stringify(loginB.data)}`);
    tokenAdminB = loginB.data.data.token;

    // Crear un cajero en Empresa A para probar RBAC
    const cajeroEmail = 'cajero.audit.test@mototrack.local';
    // Limpiar si existía
    await pool.query(
      `DELETE FROM users WHERE email = $1 AND company_id IN (SELECT id FROM companies WHERE razon_social LIKE '[PRUEBA]%')`,
      [cajeroEmail]
    );
    const rCajero = await request('/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        name: 'Cajero Prueba Audit',
        email: cajeroEmail,
        password: 'Password123!',
        role: 'cajero',
      },
    });
    if (!rCajero.ok) throw new Error(`Creación de cajero falló: ${JSON.stringify(rCajero.data)}`);

    const loginCajero = await request('/auth/login', {
      method: 'POST',
      body: { email: cajeroEmail, password: 'Password123!' },
    });
    tokenCajeroA = loginCajero.data.data.token;

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 1: Cambio de precio de producto con diff old/new
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 1: Modificación de producto y registro de diff en auditoría ---');
    // Leer precio actual
    const { rows: prodRows } = await pool.query(
      'SELECT sale_price FROM products WHERE id = $1 AND company_id = $2',
      [companyA.productId, companyAId]
    );
    const oldPrice = Number(prodRows[0].sale_price);
    const newPrice = oldPrice + 10;

    const rUpdateProd = await request(`/inventory/${companyA.productId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { sale_price: newPrice },
    });
    assert(rUpdateProd.status === 200, 'Actualización de sale_price de producto exitosa (200)');

    // Consultar logs de auditoría para este producto
    const rAuditProd = await request(`/audit?entity=product&entity_id=${companyA.productId}`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    assert(rAuditProd.status === 200, 'GET /api/audit devuelve 200 para el admin');
    const logs = rAuditProd.data?.data?.logs || [];
    const updateLog = logs.find((l) => l.action === 'update' && l.changes?.sale_price);

    assert(
      Boolean(updateLog),
      'Existe log de auditoría con action "update" para el cambio de precio',
      `logs encontrados: ${logs.length}`
    );
    assert(
      Number(updateLog?.changes?.sale_price?.old) === oldPrice &&
      Number(updateLog?.changes?.sale_price?.new) === newPrice,
      `Diff de sale_price contiene exactamente old (${oldPrice}) y new (${newPrice})`,
      `changes: ${JSON.stringify(updateLog?.changes)}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 2: Inmutabilidad de audit_logs (Trigger)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 2: Inmutabilidad estricta de audit_logs en base de datos ---');
    let updateBlocked = false;
    try {
      await pool.query(
        `UPDATE audit_logs SET action = 'tampered'
         WHERE company_id IN (SELECT id FROM companies WHERE razon_social LIKE '[PRUEBA]%')`
      );
    } catch (err) {
      if (err.message && err.message.includes('audit_logs es inmutable')) {
        updateBlocked = true;
      }
    }
    assert(updateBlocked, 'Trigger bloquea UPDATE directo sobre audit_logs con excepción explícita');

    let deleteBlocked = false;
    try {
      await pool.query(
        `DELETE FROM audit_logs
         WHERE company_id IN (SELECT id FROM companies WHERE razon_social LIKE '[PRUEBA]%')`
      );
    } catch (err) {
      if (err.message && err.message.includes('audit_logs es inmutable')) {
        deleteBlocked = true;
      }
    }
    assert(deleteBlocked, 'Trigger bloquea DELETE directo sobre audit_logs con excepción explícita');

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 3: Atomicidad Transaccional (Rollback)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 3: Atomicidad transaccional: Rollback no deja registros en audit_logs ---');
    const { rows: prodBeforeRows } = await pool.query(
      'SELECT name, sale_price FROM products WHERE id = $1',
      [companyA.productId]
    );
    const prodBefore = prodBeforeRows[0];

    const { rows: logsBeforeCount } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM audit_logs WHERE company_id = $1',
      [companyAId]
    );

    // Modificar un producto forzando error post-auditoría antes del COMMIT (Rollback real)
    const newAttemptName = `[PRUEBA] Nombre Revertido ${Date.now()}`;
    const rFailedUpdate = await request(`/inventory/${companyA.productId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenAdminA}`,
        'X-Force-Audit-Fail': '1',
      },
      body: {
        name: newAttemptName,
        _force_audit_fail: true,
      },
    });
    assert(
      rFailedUpdate.status >= 400,
      'Operación rechazada por error forzado antes del COMMIT',
      `status: ${rFailedUpdate.status}`
    );

    // Verificar en BD que el producto NO cambió
    const { rows: prodAfterRows } = await pool.query(
      'SELECT name, sale_price FROM products WHERE id = $1',
      [companyA.productId]
    );
    assert(
      prodAfterRows[0].name === prodBefore.name,
      'El producto no sufrió cambios tras el rollback de la transacción',
      `esperado: "${prodBefore.name}", actual: "${prodAfterRows[0].name}"`
    );

    const { rows: logsAfterCount } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM audit_logs WHERE company_id = $1',
      [companyAId]
    );
    assert(
      logsAfterCount[0].count === logsBeforeCount[0].count,
      'Ningún log huérfano fue insertado tras el rollback de la operación fallida',
      `antes: ${logsBeforeCount[0].count}, después: ${logsAfterCount[0].count}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 4: Aislamiento Multi-Tenant
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 4: Aislamiento estricto multi-tenant en /api/audit ---');
    // Admin B consulta con entity_id del producto de A
    const rAuditIso1 = await request(`/audit?entity=product&entity_id=${companyA.productId}`, {
      headers: { Authorization: `Bearer ${tokenAdminB}` },
    });
    const logsIso1 = rAuditIso1.data?.data?.logs || [];
    assert(
      rAuditIso1.status === 200 && logsIso1.length === 0,
      'Admin de B recibe 0 registros al intentar consultar logs de un producto de A'
    );

    // Admin B consulta su listado general: ninguno debe tener company_id de A
    const rAuditIso2 = await request('/audit', {
      headers: { Authorization: `Bearer ${tokenAdminB}` },
    });
    const logsIso2 = rAuditIso2.data?.data?.logs || [];
    const hasLogOfA = logsIso2.some((l) => Number(l.company_id) === Number(companyAId));
    assert(
      rAuditIso2.status === 200 && !hasLogOfA,
      'Listado de auditoría de B no contiene registros pertenecientes a la Empresa A'
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 5: Control de Acceso (RBAC) - Cajero 403 Forbidden
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 5: Control de Acceso (RBAC): Cajero recibe 403 en /api/audit ---');
    const rCajeroAudit = await request('/audit', {
      headers: { Authorization: `Bearer ${tokenCajeroA}` },
    });
    assert(
      rCajeroAudit.status === 403,
      'Cajero recibe 403 Forbidden al intentar acceder a /api/audit',
      `status: ${rCajeroAudit.status}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 6: Auditoría de Otros Eventos Clave (RF-09)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 6: Auditoría de eventos clave (empresa, anulación venta, margen forzado) ---');

    // 6a: Modificación de configuración de empresa (logo enmascarado)
    const testLogo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const rCompanyUpdate = await request('/company', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        telefono: '999888777',
        logo_data: testLogo,
      },
    });
    assert(rCompanyUpdate.status === 200, 'Actualización de configuración de empresa exitosa (200)');

    const rCompanyAudit = await request(`/audit?entity=company`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const companyLogs = rCompanyAudit.data?.data?.logs || [];
    const compLog = companyLogs.find((l) => l.action === 'update' && l.changes?.logo_data);
    assert(
      Boolean(compLog),
      'Log de auditoría para cambio de configuración de empresa registrado'
    );
    assert(
      compLog?.changes?.logo_data?.new === 'logo cambiado' &&
      !JSON.stringify(compLog?.changes).includes('iVBORw0KGgoAAAANSUhEUgAA'),
      'El logo_data se enmascara como "logo cambiado" y NO almacena la cadena base64 completa',
      `changes: ${JSON.stringify(compLog?.changes)}`
    );

    // 6b: Forzar margen negativo (forced_negative_margin)
    const rForcedMargin = await request(`/inventory/${companyA.productId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        cost_price: 150.00,
        sale_price: 100.00,
        force: true,
      },
    });
    assert(rForcedMargin.status === 200, 'Admin puede forzar margen negativo con force: true (200)');

    const rMarginAudit = await request(`/audit?entity=product&entity_id=${companyA.productId}`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const marginLogs = rMarginAudit.data?.data?.logs || [];
    const forcedLog = marginLogs.find((l) => l.action === 'forced_negative_margin');
    assert(
      Boolean(forcedLog),
      'Registro de auditoría específico "forced_negative_margin" registrado al forzar margen',
      `changes: ${JSON.stringify(forcedLog?.changes)}`
    );

    // 6c: Anulación de venta (void con void_reason y restored_stock)
    // Crear una venta en A para anularla
    const rSale = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: {
        customer_name: 'Cliente Audit Venta',
        payment_method: 'efectivo',
        items: [{ product_id: companyA.productId, quantity: 1 }],
      },
    });
    const saleId = rSale.data?.data?.id;
    assert(Boolean(saleId), 'Venta para anulación creada exitosamente');

    const rVoid = await request(`/sales/${saleId}/void`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      body: { void_reason: 'Error en cobro durante auditoría de prueba' },
    });
    assert(rVoid.status === 200, 'Venta anulada exitosamente (200)');

    const rSaleAudit = await request(`/audit?entity=sale&entity_id=${saleId}`, {
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    const saleLogs = rSaleAudit.data?.data?.logs || [];
    const voidLog = saleLogs.find((l) => l.action === 'void');
    assert(
      Boolean(voidLog) && voidLog?.changes?.void_reason === 'Error en cobro durante auditoría de prueba',
      'Log de anulación de venta registrado con su void_reason respectivo'
    );
    assert(
      Array.isArray(voidLog?.changes?.restored_stock) && voidLog.changes.restored_stock.length > 0,
      'Log de anulación de venta incluye detalle de restored_stock por producto',
      `restored_stock: ${JSON.stringify(voidLog?.changes?.restored_stock)}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 7: Integridad de Taller Principal (Empresa Real)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 7: Verificación de Integridad de Taller Principal ---');
    if (realCompanyId && initialRealCounts) {
      const { rows: realSales } = await pool.query('SELECT COUNT(*)::int AS count FROM sales WHERE company_id = $1', [realCompanyId]);
      const { rows: realInvoices } = await pool.query('SELECT COUNT(*)::int AS count FROM invoices WHERE company_id = $1', [realCompanyId]);
      const { rows: realWorkorders } = await pool.query('SELECT COUNT(*)::int AS count FROM work_orders WHERE company_id = $1', [realCompanyId]);
      const { rows: realAudits } = await pool.query('SELECT COUNT(*)::int AS count FROM audit_logs WHERE company_id = $1', [realCompanyId]);

      const salesUntouched = realSales[0].count === initialRealCounts.sales;
      const invUntouched = realInvoices[0].count === initialRealCounts.invoices;
      const woUntouched = realWorkorders[0].count === initialRealCounts.workorders;
      const auditUntouched = realAudits[0].count === initialRealCounts.audits;

      assert(
        salesUntouched && invUntouched && woUntouched && auditUntouched,
        'Taller Principal (empresa real) no sufrió modificaciones (ventas, facturas, OT y logs intactos)',
        `antes: ${JSON.stringify(initialRealCounts)}, después: sales=${realSales[0].count}, inv=${realInvoices[0].count}, wo=${realWorkorders[0].count}, audit=${realAudits[0].count}`
      );
    }

  } catch (err) {
    console.error('💥  Error inesperado durante la verificación:', err);
    failedTests++;
  } finally {
    // Desactivar empresas de prueba
    if (companyAId && companyBId) {
      try {
        await pool.query(
          `UPDATE companies SET is_active = false WHERE id IN ($1, $2)`,
          [companyAId, companyBId]
        );
        console.log('\n🧹  Empresas de prueba desactivadas tras la verificación.');
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
    console.log('🎉  TODAS LAS PRUEBAS DE LA TAREA 11.4 PASARON EXITOSAMENTE.');
    console.log('===============================================================\n');
    process.exit(0);
  }
}

run();
