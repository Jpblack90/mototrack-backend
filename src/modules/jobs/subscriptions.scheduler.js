import { markOverdueSubscriptions } from '../company/subscription.service.js';

/**
 * Inicia el temporizador interno para marcar automáticamente las suscripciones vencidas.
 * Controlado por la variable de entorno JOB_SUBSCRIPTIONS_MINUTES (por defecto 60 min).
 * Si es 0 o menor, el temporizador queda desactivado.
 *
 * Los errores son capturados internamente y reportados con prefijo [JOB],
 * asegurando que un fallo en el job nunca tumbe el servidor.
 */
export function startSubscriptionsScheduler() {
  const envVal = process.env.JOB_SUBSCRIPTIONS_MINUTES;
  const minutes = envVal !== undefined && envVal !== '' ? Number(envVal) : 60;

  if (isNaN(minutes) || minutes <= 0) {
    console.log('[JOB] Temporizador interno de suscripciones desactivado (JOB_SUBSCRIPTIONS_MINUTES=0)');
    return null;
  }

  const runJob = async () => {
    try {
      const result = await markOverdueSubscriptions();
      console.log(`[JOB] Verificación de suscripciones vencidas: ${result.suspended} suspendidas`);
    } catch (err) {
      console.error('[JOB] Error en ejecución de suscripciones vencidas:', err.message);
    }
  };

  // 1. Ejecución inicial al arrancar el servidor
  runJob();

  // 2. Ejecución recurrente cada N minutos
  const intervalId = setInterval(runJob, minutes * 60 * 1000);
  return intervalId;
}
