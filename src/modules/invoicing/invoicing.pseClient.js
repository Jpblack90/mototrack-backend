// =============================================================================
// PUNTO DE INTEGRACIÓN FUTURO:
//   Reemplazar el contenido de esta función por la llamada real al SDK de
//   Nubefact (u otro PSE homologado). La firma de la función debe mantenerse
//   igual para que invoicing.service.js no requiera cambios al integrar el
//   proveedor real.
//
//   Nubefact SDK de referencia: https://nubefact.com/desarrolladores/
//   (ninguna llamada HTTP real se realiza desde este archivo — es solo
//    documentación del punto de integración)
// =============================================================================

/**
 * Simula el envío de un comprobante al PSE (Proveedor de Servicios Electrónicos).
 *
 * Comportamiento:
 *   - Si simulatePseDown === true: espera 200ms y lanza error PSE_UNAVAILABLE.
 *   - En caso contrario: espera 300ms y retorna una respuesta CDR aceptada simulada.
 *
 * @param {{ xml: string, simulatePseDown?: boolean }} param0
 * @returns {Promise<{ accepted: boolean, cdr: object }>}
 */
export async function sendComprobante({ xml, simulatePseDown = false }) {
  if (simulatePseDown) {
    // Simular latencia de red antes de fallar
    await new Promise((resolve) => setTimeout(resolve, 200));

    const err = new Error('PSE no disponible — modo contingencia activado.');
    err.code = 'PSE_UNAVAILABLE';
    throw err;
  }

  // Simular latencia de procesamiento del PSE
  await new Promise((resolve) => setTimeout(resolve, 300));

  return {
    accepted: true,
    cdr: {
      code: '0',
      description: 'Aceptado simulado',
      responseDate: new Date().toISOString(),
    },
  };
}
