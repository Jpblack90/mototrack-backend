#!/usr/bin/env node
// =============================================================================
// scripts/activate-company.js
// Activa una empresa cambiando su status a 'active' y removiendo la expiración del trial.
// Registra el evento en audit_logs con user_id NULL.
// Uso: node scripts/activate-company.js <company_id>
// =============================================================================

import 'dotenv/config';
import pool from '../src/config/database.js';
import { logAudit } from '../src/shared/audit.js';

const companyIdArg = process.argv[2];

if (!companyIdArg || isNaN(Number(companyIdArg))) {
  console.error('\n❌  Error: Debes proporcionar un ID numérico de empresa.');
  console.log('📖  Uso: node scripts/activate-company.js <company_id>\n');
  process.exit(1);
}

const companyId = parseInt(companyIdArg, 10);

async function activateCompany() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Obtener datos actuales de la empresa con bloqueo
    const { rows: existingRows } = await client.query(
      `SELECT id, razon_social, nombre_comercial, status, is_active, trial_ends_at
       FROM companies
       WHERE id = $1 FOR UPDATE`,
      [companyId]
    );

    if (existingRows.length === 0) {
      throw new Error(`Empresa con ID ${companyId} no encontrada en la base de datos.`);
    }

    const prevCompany = existingRows[0];

    // 2. Actualizar estado a 'active' y trial_ends_at a NULL
    const { rows: updatedRows } = await client.query(
      `UPDATE companies
       SET status = 'active',
           is_active = true,
           trial_ends_at = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, razon_social, nombre_comercial, status, is_active, trial_ends_at`,
      [companyId]
    );

    const updatedCompany = updatedRows[0];

    // 3. Registrar auditoría con user_id NULL y acción 'activate'
    await logAudit(client, {
      companyId,
      userId: null,
      entity: 'company',
      entityId: companyId,
      action: 'activate',
      changes: {
        status: { old: prevCompany.status, new: 'active' },
        trial_ends_at: { old: prevCompany.trial_ends_at, new: null },
      },
    });

    await client.query('COMMIT');

    const name = updatedCompany.nombre_comercial || updatedCompany.razon_social;
    console.log(`\n✅  Empresa #${companyId} ("${name}") activada exitosamente.`);
    console.log(`   - Estado anterior: ${prevCompany.status} (trial_ends_at: ${prevCompany.trial_ends_at || 'NULL'})`);
    console.log(`   - Estado nuevo   : active (trial_ends_at: NULL)`);
    console.log(`   - Auditoría      : Registrado en audit_logs (action: 'activate', user_id: NULL)\n`);

    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`\n💥  Error al activar la empresa #${companyId}:`, err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

activateCompany();
