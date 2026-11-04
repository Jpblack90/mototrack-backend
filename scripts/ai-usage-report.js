#!/usr/bin/env node
// =============================================================================
// scripts/ai-usage-report.js
// Reporte mensual de consumo y costos de IA por taller (para administración).
// Uso: node scripts/ai-usage-report.js [YYYY-MM]
// =============================================================================

import 'dotenv/config';
import pool from '../src/config/database.js';

function getLimaCurrentMonth() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
  });
  return formatter.format(new Date()).slice(0, 7);
}

async function run() {
  const argMonth = process.argv[2];
  let targetMonth = argMonth;

  if (targetMonth) {
    if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
      console.error('❌  Error: Formato de mes inválido. Debe ser YYYY-MM (ej: 2026-11).');
      process.exit(1);
    }
  } else {
    targetMonth = getLimaCurrentMonth();
  }

  console.log('===============================================================');
  console.log(`📊  REPORTE DE CONSUMO DE IA POR TALLER — PERIODO: ${targetMonth}`);
  console.log('    (Zona Horaria: America/Lima)');
  console.log('===============================================================\n');

  try {
    const { rows } = await pool.query(
      `SELECT 
         c.id AS company_id,
         c.razon_social,
         c.nombre_comercial,
         COUNT(u.id)::int AS total_scans,
         COUNT(CASE WHEN u.success = true THEN 1 END)::int AS successful_scans,
         COUNT(CASE WHEN u.success = false THEN 1 END)::int AS failed_scans,
         COALESCE(SUM(u.input_tokens), 0)::bigint AS input_tokens,
         COALESCE(SUM(u.output_tokens + COALESCE(u.thinking_tokens, 0)), 0)::bigint AS output_tokens,
         COALESCE(SUM(u.estimated_cost_usd), 0)::numeric(12,4) AS total_cost_usd,
         CASE 
           WHEN COUNT(u.id) > 0 
           THEN ROUND(SUM(COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0) + COALESCE(u.thinking_tokens, 0))::numeric / COUNT(u.id), 1)
           ELSE 0 
         END AS avg_tokens_per_scan
       FROM companies c
       JOIN ai_usage u ON u.company_id = c.id
       WHERE u.created_at >= ($1 || '-01 00:00:00-05')::timestamptz
         AND u.created_at < (($1 || '-01 00:00:00-05')::timestamptz + INTERVAL '1 month')
       GROUP BY c.id, c.razon_social, c.nombre_comercial
       ORDER BY total_cost_usd DESC, total_scans DESC`,
      [targetMonth]
    );

    if (rows.length === 0) {
      console.log(`ℹ️   No se registraron consumos de IA en el periodo ${targetMonth}.\n`);
      return;
    }

    let globalScans = 0;
    let globalSuccess = 0;
    let globalFailed = 0;
    let globalInputTokens = 0n;
    let globalOutputTokens = 0n;
    let globalCost = 0;

    const formattedRows = rows.map((r) => {
      globalScans += r.total_scans;
      globalSuccess += r.successful_scans;
      globalFailed += r.failed_scans;
      globalInputTokens += BigInt(r.input_tokens);
      globalOutputTokens += BigInt(r.output_tokens);
      globalCost += Number(r.total_cost_usd);

      const name = r.nombre_comercial || r.razon_social;
      return {
        'ID': r.company_id,
        'Taller': name.length > 28 ? name.slice(0, 25) + '...' : name,
        'Escaneos': `${r.total_scans} (✓${r.successful_scans} ✗${r.failed_scans})`,
        'Tokens Entrada': Number(r.input_tokens).toLocaleString('en-US'),
        'Tokens Salida': Number(r.output_tokens).toLocaleString('en-US'),
        'Prom. Tokens/Scan': Number(r.avg_tokens_per_scan).toLocaleString('en-US'),
        'Costo Est. (USD)': `$${Number(r.total_cost_usd).toFixed(4)}`,
      };
    });

    console.table(formattedRows);

    console.log('───────────────────────────────────────────────────────────────');
    console.log('📈  TOTALES CONSOLIDADOS DEL MES:');
    console.log(`    • Total Escaneos     : ${globalScans} (Exitosos: ${globalSuccess}, Fallidos: ${globalFailed})`);
    console.log(`    • Tokens Entrada     : ${globalInputTokens.toLocaleString('en-US')}`);
    console.log(`    • Tokens Salida      : ${globalOutputTokens.toLocaleString('en-US')}`);
    console.log(`    • Costo Total Est.   : $${globalCost.toFixed(4)} USD`);
    console.log('===============================================================\n');

  } catch (err) {
    console.error('💥  Error al generar reporte de consumo de IA:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
