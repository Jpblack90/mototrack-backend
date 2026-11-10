// =============================================================================
// scripts/tests/seed-test-company.js
// Crea las empresas de prueba "[PRUEBA] Taller A" y "[PRUEBA] Taller B",
// con sus respectivos admins, mecánicos, productos, kits y órdenes de trabajo.
// Idempotente: si ya existen, las reactiva y actualiza.
// ES Module — requiere "type": "module" en package.json.
// =============================================================================

import 'dotenv/config';
import bcrypt from 'bcrypt';
import pool from '../../src/config/database.js';

const DEMO_PASSWORD = process.env.DEMO_USERS_PASSWORD || 'Demo1234!';
const SALT_ROUNDS   = 10;

async function seedOneCompany(client, config) {
  const {
    name,
    ruc,
    adminName,
    adminEmail,
    mechanicName,
    mechanicEmail,
    productSku,
    productName,
    productCost,
    productSale,
    productStock,
    kitName,
    kitPrice,
    placa,
    vehicleBrand,
    vehicleModel,
    customerName,
    customerPhone,
  } = config;

  // 1. Empresa
  let companyId;
  const { rows: compRows } = await client.query(
    `SELECT id, razon_social FROM companies WHERE razon_social = $1 OR razon_social LIKE $1 || '%' ORDER BY id ASC LIMIT 1`,
    [name]
  );

  if (compRows.length > 0) {
    companyId = compRows[0].id;
    await client.query(
      `UPDATE companies SET is_active = true, status = 'active', razon_social = $1, nombre_comercial = $1, ruc = COALESCE($2, ruc), paid_until = NULL, trial_ends_at = NULL, logo_data = NULL, telefono = NULL WHERE id = $3`,
      [name, ruc, companyId]
    );
    console.log(`ℹ️   Empresa "${name}" reactivada (id: ${companyId}).`);
  } else {
    const { rows: newComp } = await client.query(
      `INSERT INTO companies (razon_social, nombre_comercial, ruc, status, is_active)
       VALUES ($1, $1, $2, 'active', true)
       RETURNING id`,
      [name, ruc]
    );
    companyId = newComp[0].id;
    console.log(`✅  Empresa creada: "${name}" (id: ${companyId}).`);
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, SALT_ROUNDS);

  // 2. Admin de la empresa
  let adminId;
  const { rows: adminRows } = await client.query(
    `SELECT id FROM users WHERE email = $1`,
    [adminEmail]
  );
  if (adminRows.length > 0) {
    adminId = adminRows[0].id;
    await client.query(
      `UPDATE users SET company_id = $1, is_active = true, role = 'admin', password_hash = $2 WHERE id = $3`,
      [companyId, passwordHash, adminId]
    );
  } else {
    const { rows: newAdmin } = await client.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'admin', true)
       RETURNING id`,
      [companyId, adminName, adminEmail, passwordHash]
    );
    adminId = newAdmin[0].id;
  }

  // 3. Mecánico de la empresa
  let mechanicId;
  const { rows: mecRows } = await client.query(
    `SELECT id FROM users WHERE email = $1`,
    [mechanicEmail]
  );
  if (mecRows.length > 0) {
    mechanicId = mecRows[0].id;
    await client.query(
      `UPDATE users SET company_id = $1, is_active = true, role = 'mecanico', password_hash = $2 WHERE id = $3`,
      [companyId, passwordHash, mechanicId]
    );
  } else {
    const { rows: newMec } = await client.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'mecanico', true)
       RETURNING id`,
      [companyId, mechanicName, mechanicEmail, passwordHash]
    );
    mechanicId = newMec[0].id;
  }

  // 4. Producto de la empresa
  let productId;
  const { rows: prodRows } = await client.query(
    `SELECT id FROM products WHERE company_id = $1 AND sku = $2`,
    [companyId, productSku]
  );
  if (prodRows.length > 0) {
    productId = prodRows[0].id;
    await client.query(
      `UPDATE products SET is_active = true, stock = $1, cost_price = $2, sale_price = $3 WHERE id = $4`,
      [productStock, productCost, productSale, productId]
    );
  } else {
    const { rows: newProd } = await client.query(
      `INSERT INTO products (company_id, sku, name, brand, category, cost_price, sale_price, stock, min_stock, is_active)
       VALUES ($1, $2, $3, 'Genérico', 'Motor', $4, $5, $6, 3, true)
       RETURNING id`,
      [companyId, productSku, productName, productCost, productSale, productStock]
    );
    productId = newProd[0].id;
  }

  // 5. Kit de la empresa
  let kitId;
  const { rows: kitRows } = await client.query(
    `SELECT id FROM kits WHERE company_id = $1 AND name = $2`,
    [companyId, kitName]
  );
  if (kitRows.length > 0) {
    kitId = kitRows[0].id;
    await client.query(
      `UPDATE kits SET is_active = true, kit_price = $1 WHERE id = $2`,
      [kitPrice, kitId]
    );
  } else {
    const { rows: newKit } = await client.query(
      `INSERT INTO kits (company_id, name, description, kit_price, is_active)
       VALUES ($1, $2, 'Kit de prueba', $3, true)
       RETURNING id`,
      [companyId, kitName, kitPrice]
    );
    kitId = newKit[0].id;
    await client.query(
      `INSERT INTO kit_items (kit_id, product_id, quantity) VALUES ($1, $2, 1)`,
      [kitId, productId]
    );
  }

  // 6. Vehículo y Orden de Trabajo de la empresa
  let vehicleId, workOrderId;
  const { rows: vehRows } = await client.query(
    `SELECT id FROM vehicles WHERE company_id = $1 AND placa = $2`,
    [companyId, placa]
  );
  if (vehRows.length > 0) {
    vehicleId = vehRows[0].id;
  } else {
    const { rows: newVeh } = await client.query(
      `INSERT INTO vehicles (company_id, placa, brand, model, customer_name, customer_phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [companyId, placa, vehicleBrand, vehicleModel, customerName, customerPhone]
    );
    vehicleId = newVeh[0].id;
  }

  const { rows: woRows } = await client.query(
    `SELECT id FROM work_orders WHERE company_id = $1 AND vehicle_id = $2`,
    [companyId, vehicleId]
  );
  if (woRows.length > 0) {
    workOrderId = woRows[0].id;
  } else {
    const { rows: newWo } = await client.query(
      `INSERT INTO work_orders (company_id, vehicle_id, entry_mileage, status)
       VALUES ($1, $2, 10000, 'recibido')
       RETURNING id`,
      [companyId, vehicleId]
    );
    workOrderId = newWo[0].id;
  }

  return {
    companyId,
    name,
    adminId,
    adminEmail,
    adminPassword: DEMO_PASSWORD,
    mechanicId,
    mechanicEmail,
    productId,
    productSku,
    kitId,
    vehicleId,
    placa,
    workOrderId,
  };
}

export async function seedTestCompany() {
  let client;
  try {
    client = await pool.connect();
    console.log('🏢  Verificando/creando empresas de prueba ([PRUEBA] Taller A y B)...\n');

    // Empresa A
    const companyA = await seedOneCompany(client, {
      name: '[PRUEBA] Taller A',
      ruc: '20999999914',
      adminName: 'Admin Taller A',
      adminEmail: 'pruebaa@mototrack.local',
      mechanicName: 'Mecánico Taller A',
      mechanicEmail: 'mecanicoa@mototrack.local',
      productSku: 'PRUEBA-A01',
      productName: '[PRUEBA] Cilindro A',
      productCost: 50.00,
      productSale: 80.00,
      productStock: 20,
      kitName: '[PRUEBA] Kit Mantenimiento A',
      kitPrice: 75.00,
      placa: 'PLA-9999',
      vehicleBrand: 'Honda',
      vehicleModel: 'GL150',
      customerName: 'Cliente A Prueba',
      customerPhone: '999111222',
    });

    // Empresa B
    const companyB = await seedOneCompany(client, {
      name: '[PRUEBA] Taller B',
      ruc: '20999999922',
      adminName: 'Admin Taller B',
      adminEmail: 'pruebab@mototrack.local',
      mechanicName: 'Mecánico Taller B',
      mechanicEmail: 'mecanicob@mototrack.local',
      productSku: 'PRUEBA-B01',
      productName: '[PRUEBA] Pastillas B',
      productCost: 20.00,
      productSale: 35.00,
      productStock: 15,
      kitName: '[PRUEBA] Kit Frenos B',
      kitPrice: 30.00,
      placa: 'PLB-8888',
      vehicleBrand: 'Bajaj',
      vehicleModel: 'Pulsar',
      customerName: 'Cliente B Prueba',
      customerPhone: '988222333',
    });

    console.log('\n✨  Seed de empresas de prueba finalizado con éxito.\n');
    return { companyA, companyB };

  } catch (err) {
    console.error('❌  Error en seed-test-company:', err.message);
    throw err;
  } finally {
    if (client) client.release();
  }
}

// Ejecutar directamente si se llama desde CLI
if (process.argv[1]?.endsWith('seed-test-company.js')) {
  seedTestCompany()
    .then(() => pool.end())
    .catch(() => process.exit(1));
}
