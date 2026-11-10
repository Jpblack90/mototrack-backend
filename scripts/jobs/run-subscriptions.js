import 'dotenv/config';
import pool from '../../src/config/database.js';
import { markOverdueSubscriptions } from '../../src/modules/company/subscription.service.js';

async function main() {
  try {
    console.log('[JOB] Ejecutando verificación manual de suscripciones vencidas...');
    const result = await markOverdueSubscriptions();
    console.log(`[JOB] Completado con éxito: ${result.suspended} empresa(s) suspendida(s) (gracia: ${result.grace_days} días).`);
    if (result.suspended > 0) {
      console.log('[JOB] Empresas suspendidas:', result.companies);
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('[JOB] Error al ejecutar verificación manual de suscripciones:', err.message);
    await pool.end();
    process.exit(1);
  }
}

main();
