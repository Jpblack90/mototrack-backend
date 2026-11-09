import 'dotenv/config';
import pool from '../../src/config/database.js';

const API_BASE = process.env.API_URL || 'http://localhost:4000/api';
const DEMO_PASSWORD = process.env.DEMO_USERS_PASSWORD || 'Demo1234!';

async function req(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  return { status: res.status, data };
}

async function run() {
  console.log('===============================================================');
  console.log('🧪  VERIFICACIÓN ESPECÍFICA TAREA 11.2b - BACKEND');
  console.log('===============================================================\n');

  // Asegurar que solo usamos la empresa de prueba "[PRUEBA] Taller B"
  const { rows: compRows } = await pool.query(
    `SELECT id, razon_social FROM companies WHERE razon_social LIKE '[PRUEBA] Taller B%' ORDER BY id ASC LIMIT 1`
  );
  if (!compRows[0]) {
    console.error('❌  No se encontró [PRUEBA] Taller B. Ejecuta npm run test:isolation primero.');
    process.exit(1);
  }
  const companyBId = compRows[0].id;
  await pool.query(
    `UPDATE companies SET is_active = true, status = 'active', razon_social = '[PRUEBA] Taller B' WHERE id = $1`,
    [companyBId]
  );

  // Login Admin B
  const loginAdmin = await req('/auth/login', {
    method: 'POST',
    body: { email: 'pruebab@mototrack.local', password: DEMO_PASSWORD },
  });
  const tokenAdmin = loginAdmin.data?.data?.token;
  if (!tokenAdmin) {
    console.error('❌  Fallo al autenticar Admin B:', loginAdmin.data);
    process.exit(1);
  }
  console.log('🔑  Autenticado como Admin de "[PRUEBA] Taller B"');

  // 1. RUC Inválido -> 422
  console.log('\n--- 1. PUT /api/company con RUC inválido ---');
  const invalidRucRes = await req('/company', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tokenAdmin}` },
    body: { ruc: '20123456789' }, // Dígito 9 es incorrecto
  });
  console.log(`Status HTTP: ${invalidRucRes.status}`);
  console.log('Respuesta:', JSON.stringify(invalidRucRes.data, null, 2));

  // 2. RUC Válido -> 200 con explicación módulo 11
  console.log('\n--- 2. PUT /api/company con RUC válido (20123456786) ---');
  console.log('Cálculo Algoritmo SUNAT Módulo 11 para "20123456786":');
  console.log('  Dígitos:   2  0  1  2  3  4  5  6  7  8');
  console.log('  Pesos:     5  4  3  2  7  6  5  4  3  2');
  console.log('  Productos: 10 0  3  4 21 24 25 24 21 16');
  console.log('  Suma:      148');
  console.log('  Residuo:   148 % 11 = 5');
  console.log('  Diferencia: 11 - 5 = 6 (Dígito verificador esperado)');
  console.log('  Dígito en posición 11: 6 -> ¡VÁLIDO!');

  const validRucRes = await req('/company', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tokenAdmin}` },
    body: {
      ruc: '20123456786',
      razon_social: '[PRUEBA] Taller B S.A.C.',
      nombre_comercial: 'Taller B Pro',
      direccion: 'Av. Las Pruebas 456, Lima',
      telefono: '987654321',
      email: 'contacto@tallerb.pe',
      igv_rate: 0.18,
      approval_threshold: 100,
      not_picked_up_days: 15,
    },
  });
  console.log(`Status HTTP: ${validRucRes.status}`);
  console.log('Respuesta:', JSON.stringify(validRucRes.data, null, 2));

  // 3. Cajero intenta PUT /api/company -> 403
  console.log('\n--- 3. Cajero intenta PUT /api/company (RBAC) ---');
  // Crear o actualizar un cajero en Company B
  const { rows: cajeroRows } = await pool.query(
    `SELECT id FROM users WHERE email = 'cajerob@mototrack.local'`
  );
  if (cajeroRows.length === 0) {
    const bcrypt = await import('bcrypt');
    const hash = await bcrypt.default.hash(DEMO_PASSWORD, 10);
    await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active)
       VALUES ($1, 'Cajero B', 'cajerob@mototrack.local', $2, 'cajero', true)`,
      [companyBId, hash]
    );
  } else {
    await pool.query(
      `UPDATE users SET is_active = true, role = 'cajero' WHERE id = $1`,
      [cajeroRows[0].id]
    );
  }

  const loginCajero = await req('/auth/login', {
    method: 'POST',
    body: { email: 'cajerob@mototrack.local', password: DEMO_PASSWORD },
  });
  const tokenCajero = loginCajero.data?.data?.token;

  const cajeroPutRes = await req('/company', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tokenCajero}` },
    body: { nombre_comercial: 'Hack Por Cajero' },
  });
  console.log(`Status HTTP: ${cajeroPutRes.status}`);
  console.log('Respuesta:', JSON.stringify(cajeroPutRes.data, null, 2));

  // 4. Cambiar IGV a 10%, crear venta -> igv_rate = 0.10 e IGV calculado al 10%
  console.log('\n--- 4. Cambiar IGV a 10% y crear venta en B ---');
  await req('/company', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tokenAdmin}` },
    body: { igv_rate: 0.10 },
  });

  // Producto de B
  const { rows: prodB } = await pool.query(
    `SELECT id, sale_price FROM products WHERE company_id = $1 AND is_active = true LIMIT 1`,
    [companyBId]
  );
  const sale10Res = await req('/sales', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenAdmin}` },
    body: {
      customer_name: 'Cliente IGV 10%',
      payment_method: 'efectivo',
      items: [{ product_id: prodB[0].id, quantity: 1 }],
    },
  });
  console.log('Venta creada con IGV al 10%:');
  console.log(JSON.stringify(sale10Res.data?.data, null, 2));

  // Restaurar IGV a 18%
  await req('/company', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tokenAdmin}` },
    body: { igv_rate: 0.18 },
  });
  console.log('✅  IGV de Empresa B restaurado a 0.18 (18%).');

  // 5. Cambiar umbral a 50 -> OT con costo adicional 60 pasa a pendiente_aprobacion
  console.log('\n--- 5. Umbral de aprobación a S/ 50 y OT con costo adicional S/ 60 ---');
  await req('/company', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tokenAdmin}` },
    body: { approval_threshold: 50 },
  });

  // Crear OT en B y pasarla a diagnostico
  const { rows: vehB } = await pool.query(
    `SELECT id FROM vehicles WHERE company_id = $1 LIMIT 1`,
    [companyBId]
  );
  const { rows: newWo } = await pool.query(
    `INSERT INTO work_orders (company_id, vehicle_id, entry_mileage, status)
     VALUES ($1, $2, 12000, 'diagnostico') RETURNING id`,
    [companyBId, vehB[0].id]
  );
  const woId = newWo[0].id;

  const patchWoRes = await req(`/workorders/${woId}/status`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenAdmin}` },
    body: {
      status: 'en_reparacion',
      diagnosis_notes: 'Cambio de piezas adicionales requeridas',
      additional_cost: 60,
    },
  });
  console.log(`Estado resultante de la OT #${woId}:`, patchWoRes.data?.data?.status);
  console.log('Requiere aprobación:', patchWoRes.data?.data?.requires_approval);
  console.log('Detalle OT:', JSON.stringify(patchWoRes.data?.data, null, 2));

  // Restaurar umbral a 100
  await req('/company', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tokenAdmin}` },
    body: { approval_threshold: 100 },
  });
  console.log('✅  Umbral de aprobación de Empresa B restaurado a S/ 100.');

  // 6. Facturar sin RUC -> 422 con mensaje exacto
  console.log('\n--- 6. Facturar sin RUC -> 422 ---');
  await pool.query(`UPDATE companies SET ruc = NULL WHERE id = $1`, [companyBId]);

  const invoiceWithoutRucRes = await req('/invoicing', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenAdmin}` },
    body: {
      sale_id: sale10Res.data?.data?.id,
      comprobante_type: 'boleta',
    },
  });
  console.log(`Status HTTP: ${invoiceWithoutRucRes.status}`);
  console.log('Respuesta:', JSON.stringify(invoiceWithoutRucRes.data, null, 2));

  // Restaurar RUC válido en B
  await pool.query(`UPDATE companies SET ruc = '20999999922' WHERE id = $1`, [companyBId]);
  console.log('✅  RUC restaurado en Empresa B.');

  // Desactivar empresas de prueba
  await pool.query(
    `UPDATE companies SET is_active = false WHERE razon_social LIKE '[PRUEBA]%'`
  );
  console.log('🧹  Empresas de prueba desactivadas.');
  await pool.end();
}

run();
