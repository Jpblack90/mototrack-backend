import { decrypt } from '../../../shared/utils/crypto.js';

const PSE_TIMEOUT_MS = 15000;

/**
 * Proveedor oficial para NubeFacT (API REST JSON).
 *
 * FUENTES OFICIALES (almacenadas localmente en Sistema/docs/pse/nubefact/):
 * 1. Manual oficial: "MANUAL_INTEGRACION_JSON.pdf" / "MANUAL_INTEGRACION_JSON.txt"
 *    Descargado desde el enlace oficial "Manual JSON" en https://www.nubefact.com/integracion
 * 2. Ejemplos oficiales JSON: "EJEMPLOS-DE-ARCHIVOS-JSON.zip" / carpeta "ejemplos/"
 *    Descargados desde https://www.nubefact.com/downloads/EJEMPLOS-DE-ARCHIVOS-JSON
 * 3. Código de ejemplo oficial en PHP: "NubeFact-json.php" (extraído de PHP-INTEGRACION-CON-NUBEFACT-EJEMPLO-CODIGO-JSON.zip)
 *    Descargado desde https://www.nubefact.com/downloads/PHP-INTEGRACION-CON-NUBEFACT-EJEMPLO-CODIGO-JSON
 *
 * REFERENCIA EXACTA DE ESTRUCTURAS Y SECCIONES:
 * - Autenticación HTTP (Header "Authorization: Token token=\"...\""):
 *   Formato oficial implementado en "NubeFact-json.php", línea 158:
 *   'Authorization: Token token="'.$token.'"' (y comentarios líneas 141-142).
 *   (El manual en sección "CÓMO USAR LA RUTA Y EL TOKEN" en pág. 2 omite el prefijo, pero la
 *   implementación de referencia de Nubefact requiere estrictamente el esquema 'Token token="..."').
 * - Estructura de solicitud "generar_comprobante" (Facturas y Boletas):
 *   Manual págs. 8-12, sección "ESTRUCTURA DE ARCHIVOS JSON -> ESTRUCTURA PARA GENERAR FACTURAS, BOLETAS Y NOTAS".
 *   Ejemplos: "EJEMPLO JSON GENERAR CPE BOLETA 1 GRAVADA.txt", "EJEMPLO JSON GENERAR CPE FACTURA 1 GRAVADA.txt".
 * - Estructura de solicitud para Notas de Crédito (Catálogo 09 SUNAT):
 *   Manual págs. 9 y 12 (campos "documento_que_se_modifica_tipo", "documento_que_se_modifica_serie",
 *   "documento_que_se_modifica_numero", "tipo_de_nota_de_credito").
 *   Ejemplo: "EJEMPLO JSON GENERAR CPE NOTA CREDITO 1 PARA FACTURA.txt".
 * - Estructura de solicitud "consultar_comprobante":
 *   Manual págs. 5 y 13, sección "ESTRUCTURA PARA CONSULTAR FACTURAS, BOLETAS Y NOTAS".
 *   Ejemplos: "EJEMPLO JSON CONSULTAR CPE BOLETA.txt", "EJEMPLO JSON CONSULTAR CPE FACTURA.txt".
 * - Estructura de respuesta de Nubefact (éxito y campos SUNAT):
 *   Manual pág. 13, sección "ESTRUCTURA DE RESPUESTA DE NUBEFACT PARA FACTURAS, BOLETAS, NOTAS"
 *   (campos: "tipo_de_comprobante", "serie", "numero", "enlace_del_pdf", "enlace_del_xml",
 *    "aceptada_por_sunat", "sunat_description", "cadena_para_codigo_qr", "codigo_hash").
 * - Manejo de errores y códigos de respuesta:
 *   Manual pág. 15, sección "MANEJO DE ERRORES -> MENSAJES DE ERROR":
 *   Código 10: "No se pudo autenticar, token incorrecto o eliminado"
 *   Código 20: "El archivo enviado no cumple con el formato establecido"
 *   Código 21: "No se pudo completar la operación, se acompaña el problema con un mensaje"
 *   Código 23: "Este documento ya existe en NubeFacT"
 *   Código 24: "El documento indicado no existe o no fue enviado a NubeFacT"
 */
export const nubefactProvider = {
  name: 'nubefact',

  /**
   * Obtiene y descifra el token de autorización configurado para la empresa.
   *
   * @param {object} company
   * @returns {string} Token en texto plano
   */
  getToken(company) {
    if (!company?.pse_token_enc) {
      const err = new Error('La empresa no tiene configurado el token de Nubefact.');
      err.code = 'PSE_TOKEN_MISSING';
      err.statusCode = 422;
      throw err;
    }
    const token = decrypt(company.pse_token_enc);
    if (!token) {
      const err = new Error('No se pudo descifrar el token de Nubefact.');
      err.code = 'PSE_TOKEN_INVALID';
      err.statusCode = 500;
      throw err;
    }
    return token;
  },

  /**
   * Emite un comprobante (factura, boleta o nota de crédito) hacia Nubefact.
   * Estructura: Manual págs. 8-12 ("ESTRUCTURA PARA GENERAR FACTURAS, BOLETAS Y NOTAS").
   *
   * @param {{ type: string, company: object, document: object }} params
   * @returns {Promise<{ accepted: boolean, sunat_description: string, pdf_url: string|null, xml_url: string|null, hash: string|null, qr_string: string|null, raw: object }>}
   */
  async send({ type, company, document }) {
    if (!company?.pse_url) {
      const err = new Error('La empresa no tiene configurada la ruta (URL) de Nubefact.');
      err.code = 'PSE_URL_MISSING';
      err.statusCode = 422;
      throw err;
    }

    const token = this.getToken(company);

    // Formatear payload según manual oficial de Nubefact (Págs. 8-12)
    const payload = {
      operacion: 'generar_comprobante',
      tipo_de_comprobante: document.tipo_de_comprobante, // 1 = Factura, 2 = Boleta, 3 = NC
      serie: document.serie,
      numero: document.numero,
      sunat_transaction: 1,
      cliente_tipo_de_documento: document.cliente_tipo_de_documento,
      cliente_numero_de_documento: document.cliente_numero_de_documento,
      cliente_denominacion: document.cliente_denominacion,
      cliente_direccion: document.cliente_direccion || '',
      cliente_email: document.cliente_email || '',
      fecha_de_emision: document.fecha_de_emision,
      moneda: 1,
      tipo_de_cambio: '',
      porcentaje_de_igv: document.porcentaje_de_igv ?? 18.00,
      total_gravada: document.total_gravada,
      total_inafecta: 0.00,
      total_exonerada: 0.00,
      total_igv: document.total_igv,
      total: document.total,
      enviar_automaticamente_a_la_sunat: true,
      enviar_automaticamente_al_cliente: false,
      items: document.items,
    };

    // Parámetros específicos para Nota de Crédito (Catálogo 09 SUNAT, Manual Págs. 9 y 12)
    if (document.tipo_de_comprobante === 3) {
      payload.documento_que_se_modifica_tipo = document.documento_que_se_modifica_tipo;
      payload.documento_que_se_modifica_serie = document.documento_que_se_modifica_serie;
      payload.documento_que_se_modifica_numero = document.documento_que_se_modifica_numero;
      payload.tipo_de_nota_de_credito = document.tipo_de_nota_de_credito;
      payload.motivo = document.motivo || 'Anulación de la operación';
    }

    let res;
    let data;

    try {
      res = await fetch(company.pse_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token token="${token}"`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PSE_TIMEOUT_MS),
      });

      data = await res.json().catch(() => ({}));

      if (res.status >= 500) {
        const err = new Error(`Nubefact respondió con error de servidor HTTP ${res.status}`);
        err.code = 'PSE_UNAVAILABLE';
        throw err;
      }

      if (res.status === 401 || res.status === 403) {
        const err = new Error(data.errors || 'Token de Nubefact no autorizado o inválido.');
        err.code = 'PSE_AUTH_FAILED';
        err.statusCode = 422;
        err.raw = data;
        throw err;
      }
    } catch (networkErr) {
      if (networkErr.code === 'PSE_AUTH_FAILED' || networkErr.code === 'PSE_UNAVAILABLE') {
        throw networkErr;
      }
      // Timeout o fallo de red -> contingencia (RF-28)
      const err = new Error(`Fallo de conexión con Nubefact: ${networkErr.message}`);
      err.code = 'PSE_UNAVAILABLE';
      throw err;
    }

    // Detección estricta de duplicado según manual oficial de Nubefact:
    // Manual pág. 15, "MANEJO DE ERRORES -> MENSAJES DE ERROR"
    // Código 23: "Este documento ya existe en NubeFacT"
    const isDuplicate =
      Number(data?.codigo) === 23 ||
      (typeof data?.errors === 'string' && data.errors.trim() === 'Este documento ya existe en NubeFacT');

    if (isDuplicate) {
      // Reintentar consultando el comprobante ya existente sin duplicar ni fallar
      const queryResult = await this.query({
        type,
        company,
        document: {
          tipo_de_comprobante: document.tipo_de_comprobante,
          serie: document.serie,
          numero: document.numero,
        },
      });

      // Si la consulta responde que el documento NO existe (Manual pág. 15, Código 24: "El documento indicado no existe o no fue enviado a NubeFacT"),
      // el comprobante NO puede marcarse como accepted: queda en 'contingency' y se loguea con prefijo [PSE].
      const isNotFound =
        Number(queryResult.raw?.codigo) === 24 ||
        (typeof queryResult.raw?.errors === 'string' &&
          queryResult.raw.errors.toLowerCase().includes('no existe')) ||
        (!queryResult.accepted && !queryResult.hash);

      if (isNotFound) {
        const detailMsg = queryResult.raw?.errors || 'El documento indicado no existe o no fue enviado a NubeFacT';
        console.warn(`[PSE] Documento ${document.serie}-${document.numero} reportado como duplicado pero consultar_comprobante indica que no existe: ${detailMsg}`);
        const err = new Error(`[PSE] Documento reportado como duplicado pero no existe en consultar_comprobante: ${detailMsg}`);
        err.code = 'PSE_UNAVAILABLE';
        err.raw = queryResult.raw;
        throw err;
      }

      return queryResult;
    }

    const accepted = Boolean(data.aceptada_por_sunat);
    const errorText = typeof data?.errors === 'string'
      ? data.errors
      : Array.isArray(data?.errors)
        ? data.errors.join('; ')
        : (data?.errors ? JSON.stringify(data.errors) : '');

    return {
      accepted,
      sunat_description: data.sunat_description || errorText || (accepted ? 'Aceptado por SUNAT' : 'Rechazado'),
      pdf_url: data.enlace_del_pdf || data.enlace || null,
      xml_url: data.enlace_del_xml || null,
      hash: data.codigo_hash || data.hash || null,
      qr_string: data.cadena_para_codigo_qr || null,
      raw: data,
    };
  },

  /**
   * Consulta el estado de un comprobante en Nubefact mediante "consultar_comprobante".
   * Estructura: Manual págs. 5 y 13 ("ESTRUCTURA PARA CONSULTAR FACTURAS, BOLETAS Y NOTAS").
   *
   * @param {{ type?: string, company: object, document: { tipo_de_comprobante?: number, serie: string, numero: number } }} params
   */
  async query({ type, company, document }) {
    if (!company?.pse_url) {
      const err = new Error('La empresa no tiene configurada la ruta (URL) de Nubefact.');
      err.code = 'PSE_URL_MISSING';
      err.statusCode = 422;
      throw err;
    }

    const token = this.getToken(company);

    const payload = {
      operacion: 'consultar_comprobante',
      tipo_de_comprobante: document.tipo_de_comprobante || (document.serie?.startsWith('F') ? 1 : 2),
      serie: document.serie,
      numero: document.numero,
    };

    let res;
    let data;

    try {
      res = await fetch(company.pse_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token token="${token}"`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PSE_TIMEOUT_MS),
      });

      data = await res.json().catch(() => ({}));

      if (res.status >= 500) {
        const err = new Error(`Nubefact respondió con error de servidor HTTP ${res.status}`);
        err.code = 'PSE_UNAVAILABLE';
        throw err;
      }

      if (res.status === 401 || res.status === 403) {
        const err = new Error(data.errors || 'Token de Nubefact no autorizado o inválido.');
        err.code = 'PSE_AUTH_FAILED';
        err.statusCode = 422;
        err.raw = data;
        throw err;
      }
    } catch (networkErr) {
      if (networkErr.code === 'PSE_AUTH_FAILED' || networkErr.code === 'PSE_UNAVAILABLE') {
        throw networkErr;
      }
      const err = new Error(`Fallo al consultar comprobante en Nubefact: ${networkErr.message}`);
      err.code = 'PSE_UNAVAILABLE';
      throw err;
    }

    const errorText = typeof data?.errors === 'string'
      ? data.errors
      : Array.isArray(data?.errors)
        ? data.errors.join('; ')
        : (data?.errors ? JSON.stringify(data.errors) : '');

    const accepted = Boolean(data.aceptada_por_sunat);

    return {
      accepted,
      sunat_description: data.sunat_description || errorText || (accepted ? 'Aceptado por SUNAT' : 'Consulta procesada'),
      pdf_url: data.enlace_del_pdf || data.enlace || null,
      xml_url: data.enlace_del_xml || null,
      hash: data.codigo_hash || data.hash || null,
      qr_string: data.cadena_para_codigo_qr || null,
      raw: data,
    };
  },
};
