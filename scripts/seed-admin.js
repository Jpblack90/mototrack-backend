// =============================================================================
// scripts/seed-admin.js
// Crea el primer usuario Administrador si no existe ninguno.
// Uso: npm run seed:admin
// ES Module — requiere "type": "module" en package.json (ya configurado).
// =============================================================================

import 'dotenv/config';
import bcrypt from 'bcrypt';
import pool from '../src/config/database.js';

const ADMIN_NAME     = 'Administrador';
const ADMIN_EMAIL    = 'admin@mototrack.local';
const ADMIN_PASSWORD = 'Admin123!';  // contraseña en texto plano — se hashea a continuación
const SALT_ROUNDS    = 10;

async function seedAdmin() {
  let client;
  try {
    client = await pool.connect();

    // Verificar si ya existe al menos un admin
    const { rows } = await client.query(
      `SELECT id, email FROM users WHERE role = 'admin' LIMIT 1`
    );

    if (rows.length > 0) {
      console.log(`ℹ️  Ya existe un usuario Administrador (${rows[0].email}). No se creó ninguno nuevo.`);
      return;
    }

    // Hashear contraseña
    const password_hash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);

    // Insertar el admin
    const { rows: created } = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id, name, email, role`,
      [ADMIN_NAME, ADMIN_EMAIL, password_hash]
    );

    console.log('\n✅  Usuario Administrador creado exitosamente:');
    console.log(`    Email    : ${created[0].email}`);
    console.log(`    Contraseña (texto plano): ${ADMIN_PASSWORD}`);
    console.log('\n⚠️  ADVERTENCIA: CAMBIA ESTA CONTRASEÑA EN CUANTO SE IMPLEMENTE');
    console.log('   EL ENDPOINT DE CAMBIO DE CONTRASEÑA. NO LA DEJES EN PRODUCCIÓN.\n');

  } catch (err) {
    console.error('❌  Error al crear el Administrador:', err.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

seedAdmin();
