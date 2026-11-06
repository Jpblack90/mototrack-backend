/**
 * Plantillas oficiales de mensajes de WhatsApp para clientes (RF-15 / Fase 1).
 * Fuente única de verdad para el armado de avisos por evento.
 */

export const WHATSAPP_EVENTS = {
  RECIBIDO: 'recibido',
  PENDIENTE_APROBACION: 'pendiente_aprobacion',
  TERMINADO: 'terminado',
  NO_RECOGIDO: 'no_recogido',
};

/**
 * Genera el texto del mensaje para WhatsApp según el evento y los parámetros provistos.
 * Si algún dato falta, se omite de forma natural sin dejar llaves vacías ni generar datos inventados.
 *
 * @param {'recibido'|'pendiente_aprobacion'|'terminado'|'no_recogido'} event
 * @param {{ cliente?: string, placa?: string, taller?: string, monto?: number|string, dias?: number|string }} params
 * @returns {string|null}
 */
export function buildWhatsAppMessage(event, params = {}) {
  const cliente = params.cliente ? String(params.cliente).trim() : '';
  const placa = params.placa ? String(params.placa).trim().toUpperCase() : '';
  const taller = params.taller ? String(params.taller).trim() : '';
  const monto =
    params.monto !== undefined && params.monto !== null && params.monto !== ''
      ? Number(params.monto).toFixed(2)
      : null;
  const dias =
    params.dias !== undefined && params.dias !== null ? Number(params.dias) : null;

  const saludo = cliente ? `Hola ${cliente}` : 'Hola';
  const refMoto = placa ? `tu moto ${placa}` : 'tu moto';
  const enTaller = taller ? ` en ${taller}` : '';

  switch (event) {
    case WHATSAPP_EVENTS.RECIBIDO:
      return `${saludo}, recibimos ${refMoto}${enTaller}. Te avisaremos cuando esté lista.`;

    case WHATSAPP_EVENTS.PENDIENTE_APROBACION: {
      const parteMonto = monto ? ` de S/ ${monto}` : '';
      return `${saludo}, ${refMoto} necesita un trabajo adicional${parteMonto}. Por favor confirma si lo autorizas.`;
    }

    case WHATSAPP_EVENTS.TERMINADO:
      return `${saludo}, ${refMoto} ya está lista para recoger${enTaller}.`;

    case WHATSAPP_EVENTS.NO_RECOGIDO: {
      const parteDias = dias !== null ? ` desde hace ${dias} días` : '';
      const cierreTaller = taller ? `Te esperamos en ${taller}.` : 'Te esperamos para la entrega.';
      return `${saludo}, ${refMoto} está lista${parteDias}. ${cierreTaller}`;
    }

    default:
      return null;
  }
}
