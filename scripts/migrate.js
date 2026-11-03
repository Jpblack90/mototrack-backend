// =============================================================================
// scripts/migrate.js
// Runner de migraciones SQL transaccionales para MotoTrack AI.
// Registra las migraciones aplicadas en la tabla 'schema_migrations'.
// Uso: npm run migrate
// ES Module — requiere "type": "module" en package.json.
// =============================================================================

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../src/config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function runMigrations() {
  let client;
  try {
    client = await pool.connect();

    // 1. Crear tabla schema_migrations si no existe
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
    `);

    // 2. Obtener lista de migraciones ya aplicadas
    const { rows: appliedRows } = await client.query(
      `SELECT filename FROM schema_migrations;`
    );
    const appliedSet = new Set(appliedRows.map((r) => r.filename));

    // 3. Leer archivos en scripts/migrations/ ordenados alfabéticamente
    let files = [];
    try {
      const dirEntries = await fs.readdir(MIGRATIONS_DIR);
      files = dirEntries
        .filter((file) => file.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(`ℹ️  No se encontró la carpeta ${MIGRATIONS_DIR}. Sin migraciones pendientes.`);
        return;
      }
      throw err;
    }

    const pending = files.filter((f) => !appliedSet.has(f));

    if (pending.length === 0) {
      console.log('ℹ️  Sin migraciones pendientes.');
      return;
    }

    console.log(`🚀  Se encontraron ${pending.length} migración(es) pendiente(s):\n`);

    // 4. Aplicar cada migración en su propia transacción
    for (const filename of pending) {
      const filePath = path.join(MIGRATIONS_DIR, filename);
      const sql = await fs.readFile(filePath, 'utf-8');

      console.log(`⏳  Aplicando: ${filename}...`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (filename) VALUES ($1);`,
          [filename]
        );
        await client.query('COMMIT');
        console.log(`✅  Migración aplicada con éxito: ${filename}`);
      } catch (migrationErr) {
        await client.query('ROLLBACK');
        console.error(`❌  Error al aplicar la migración "${filename}":`, migrationErr.message);
        process.exit(1);
      }
    }

    console.log('\n🎉  Todas las migraciones fueron aplicadas correctamente.\n');
  } catch (err) {
    console.error('❌  Error general en el runner de migraciones:', err.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

runMigrations();
