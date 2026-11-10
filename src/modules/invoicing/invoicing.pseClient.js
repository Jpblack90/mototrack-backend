import { simulatedProvider } from './pse/simulated.js';

/**
 * Adaptador de compatibilidad para código que importe directamente sendComprobante.
 * Delega en simulatedProvider.
 */
export async function sendComprobante({ xml, simulatePseDown = false }) {
  const result = await simulatedProvider.send({
    type: 'invoice',
    company: { pse_provider: 'simulado' },
    document: {},
    simulatePseDown,
  });

  return {
    accepted: result.accepted,
    cdr: result.raw,
  };
}
