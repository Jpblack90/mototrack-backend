import 'dotenv/config';
import pool from '../../src/config/database.js';
import { markOverdueNotPickedUp } from '../../src/modules/workorders/workorders.service.js';

async function main() {
  try {
    console.log('[JOB] Ejecutando verificación manual de motos no recogidas...');
    const result = await markOverdueNotPickedUp();
    console.log(`[JOB] Completado con éxito: ${result.updated} orden(es) actualizada(s) a 'no_recogido'.`);
    if (result.updated > 0) {
      console.log('[JOB] Desglose por empresa:', result.by_company);
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('[JOB] Error al ejecutar verificación manual:', err.message);
    await pool.end();
    process.exit(1);
  }
}

main();
