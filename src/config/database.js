import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

/**
 * Verifica la conexión a PostgreSQL ejecutando SELECT NOW().
 * Llamar desde server.js antes de arrancar el servidor.
 */
export async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    console.log(`✅  PostgreSQL conectado. Hora del servidor: ${result.rows[0].now}`);
  } catch (error) {
    console.error('❌  Error al conectar con PostgreSQL:', error.message);
    process.exit(1); // Detiene el servidor si la BD no está disponible
  } finally {
    if (client) client.release();
  }
}

export default pool;
