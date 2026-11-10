/**
 * Proveedor PSE Simulado (para desarrollo y pruebas locales).
 * Mantiene compatibilidad con el comportamiento histórico de invoicing.pseClient.js.
 */
export const simulatedProvider = {
  name: 'simulado',

  /**
   * Simula el envío de un comprobante al PSE.
   *
   * @param {{ type: string, company: object, document: object, simulatePseDown?: boolean }} params
   * @returns {Promise<{ accepted: boolean, sunat_description: string, pdf_url: string|null, xml_url: string|null, hash: string|null, qr_string: string|null, raw: object }>}
   */
  async send({ type, company, document, simulatePseDown = false }) {
    if (simulatePseDown) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const err = new Error('PSE no disponible — modo contingencia activado.');
      err.code = 'PSE_UNAVAILABLE';
      throw err;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));

    const cdr = {
      code: '0',
      description: 'Aceptado simulado',
      responseDate: new Date().toISOString(),
    };

    return {
      accepted: true,
      sunat_description: 'Aceptado simulado por proveedor de pruebas',
      pdf_url: null,
      xml_url: null,
      hash: null,
      qr_string: null,
      raw: cdr,
    };
  },

  /**
   * Simula la consulta del estado de un comprobante.
   */
  async query({ type, company, document }) {
    return {
      accepted: true,
      sunat_description: 'Aceptado simulado por proveedor de pruebas',
      pdf_url: null,
      xml_url: null,
      hash: null,
      qr_string: null,
      raw: {
        code: '0',
        description: 'Consulta simulada exitosa',
        responseDate: new Date().toISOString(),
      },
    };
  },
};
