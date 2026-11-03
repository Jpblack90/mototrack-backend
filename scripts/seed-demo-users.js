// =============================================================================
// scripts/seed-demo-users.js
// Crea los usuarios de demostración por rol (cajero, almacenero, mecanico)
// si aún no existen (idempotente).
// Uso: npm run seed:demo
// ES Module — requiere "type": "module" en package.json.
// =============================================================================

import 'dotenv/config';
import bcrypt from 'bcrypt';
import pool from '../src/config/database.js';

const DEMO_PASSWORD = process.env.DEMO_USERS_PASSWORD;
const SALT_ROUNDS   = 10;

const DEMO_USERS = [
  {
    name:  'Cajero Demo',
    email: 'cajero@mototrack.local',
    role:  'cajero',
  },
  {
    name:  'Almacenero Demo',
    email: 'almacenero@mototrack.local',
    role:  'almacenero',
  },
  {
    name:  'Mecánico Demo',
    email: 'mecanico@mototrack.local',
    role:  'mecanico',
  },
];

async function seedDemoUsers() {
  if (!DEMO_PASSWORD || DEMO_PASSWORD.trim() === '') {
    console.error('❌  Error: Variable de entorno DEMO_USERS_PASSWORD no definida.');
    console.error('   Define DEMO_USERS_PASSWORD en tu archivo .env antes de ejecutar este script.');
    process.exit(1);
  }

  let client;
  try {
    client = await pool.connect();
    console.log('🌱  Iniciando seed de usuarios de demostración...\n');

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, SALT_ROUNDS);

    for (const u of DEMO_USERS) {
      const { rows } = await client.query(
        `SELECT id, email, role FROM users WHERE email = $1;`,
        [u.email]
      );

      if (rows.length > 0) {
        console.log(`ℹ️   Usuario "${u.email}" (${rows[0].role}) ya existe. Omitido.`);
      } else {
        const { rows: inserted } = await client.query(
          `INSERT INTO users (name, email, password_hash, role)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, email, role;`,
          [u.name, u.email, passwordHash, u.role]
        );
        console.log(`✅  Usuario creado: ${inserted[0].name} <${inserted[0].email}> [${inserted[0].role}]`);
      }
    }

    console.log('\n✨  Seed de usuarios demo finalizado con éxito.\n');
  } catch (err) {
    console.error('❌  Error al ejecutar seed de usuarios demo:', err.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

seedDemoUsers();
