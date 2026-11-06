import { markOverdueNotPickedUp } from '../workorders/workorders.service.js';

/**
 * Inicia el temporizador interno para marcar automáticamente las motos no recogidas.
 * Controlado por la variable de entorno JOB_NOT_PICKED_UP_MINUTES (por defecto 60 min).
 * Si es 0 o menor, el temporizador queda desactivado.
 *
 * Los errores son capturados internamente y reportados con prefijo [JOB],
 * asegurando que un fallo en el job nunca tumbe el servidor.
 */
export function startNotPickedUpScheduler() {
  const envVal = process.env.JOB_NOT_PICKED_UP_MINUTES;
  const minutes = envVal !== undefined && envVal !== '' ? Number(envVal) : 60;

  if (isNaN(minutes) || minutes <= 0) {
    console.log('[JOB] Temporizador interno desactivado (JOB_NOT_PICKED_UP_MINUTES=0)');
    return null;
  }

  const runJob = async () => {
    try {
      const result = await markOverdueNotPickedUp();
      console.log(`[JOB] Verificación de motos no recogidas: ${result.updated} actualizadas`);
    } catch (err) {
      console.error('[JOB] Error en ejecución de motos no recogidas:', err.message);
    }
  };

  // 1. Ejecución inicial al arrancar el servidor
  runJob();

  // 2. Ejecución recurrente cada N minutos
  const intervalId = setInterval(runJob, minutes * 60 * 1000);
  return intervalId;
}
