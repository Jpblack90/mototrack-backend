import pool from '../../config/database.js';
import { sendComprobante } from './invoicing.pseClient.js';
import { logAudit } from '../../shared/audit.js';

// ─── Errores controlados ──────────────────────────────────────────────────────

class AppError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.status = statusCode;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escapa caracteres especiales para XML.
 */
function escapeXml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Construye un XML simplificado para el comprobante.
 *
 * ⚠️  REPRESENTACIÓN SIMPLIFICADA CON FINES ACADÉMICOS.
 *    Este XML NO es UBL 2.1 válido ni cumple el esquema oficial de SUNAT.
 *    En la integración real con un PSE homologado, reemplazar esta función
 *    por la generación de XML conforme al Anexo 8 de SUNAT o usar el SDK
 *    del proveedor (Nubefact, Edicom, etc.) que lo genera internamente.
 *
 * @param {object} sale       Fila de la tabla sales con sus ítems expandidos
 * @param {object} invoiceData  { comprobante_type, serie, numero, customer_document_type, customer_document_number }
 * @param {object} companyInfo { ruc, razon_social, direccion }
 * @returns {string}
 */
export function buildSimplifiedXml(sale, invoiceData, companyInfo = {}) {
  const { comprobante_type, serie, numero, customer_document_type, customer_document_number } =
    invoiceData;
  const company = invoiceData.company || companyInfo;

  const itemsXml = (sale.items ?? [])
    .map(
      (item) => `
    <item>
      <description>${escapeXml(item.product_name ?? item.kit_name ?? 'Ítem')}</description>
      <quantity>${item.quantity}</quantity>
      <unitPrice>${item.unit_price}</unitPrice>
      <subtotal>${item.subtotal}</subtotal>
    </item>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<comprobante xmlns:mototrack="urn:mototrack:simplified:1.0">
  <tipo>${comprobante_type}</tipo>
  <serie>${serie}</serie>
  <numero>${numero}</numero>
  <fechaEmision>${new Date().toISOString()}</fechaEmision>
  <emisor>
    <ruc>${company.ruc ?? ''}</ruc>
    <razonSocial>${escapeXml(company.razon_social ?? company.name ?? '')}</razonSocial>
    <direccion>${escapeXml(company.direccion ?? company.address ?? '')}</direccion>
  </emisor>
  <receptor>
    <tipoDocumento>${customer_document_type ?? ''}</tipoDocumento>
    <numeroDocumento>${customer_document_number ?? ''}</numeroDocumento>
  </receptor>
  <items>${itemsXml}
  </items>
  <totales>
    <subtotal>${sale.subtotal}</subtotal>
    <igv>${sale.igv}</igv>
    <total>${sale.total}</total>
  </totales>
</comprobante>`;
}

/**
 * Construye un XML simplificado para la Nota de Crédito.
 *
 * @param {object} param0
 * @param {object} param0.sale       Fila de sales con items expandidos
 * @param {object} param0.invoice    Fila de invoices que se modifica
 * @param {object} param0.ncData     { serie, numero, motivo_code, motivo_descripcion }
 * @param {object} param0.company    { ruc, razon_social, direccion }
 * @returns {string}
 */
export function buildCreditNoteXml({ sale, invoice, ncData, company = {} }) {
  const itemsXml = (sale.items ?? [])
    .map(
      (item) => `
    <item>
      <description>${escapeXml(item.product_name ?? item.kit_name ?? item.description ?? 'Ítem')}</description>
      <quantity>${item.quantity}</quantity>
      <unitPrice>${item.unit_price}</unitPrice>
      <subtotal>${item.subtotal}</subtotal>
    </item>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<comprobante xmlns:mototrack="urn:mototrack:simplified:1.0">
  <tipo>nota_credito</tipo>
  <serie>${ncData.serie}</serie>
  <numero>${ncData.numero}</numero>
  <fechaEmision>${new Date().toISOString()}</fechaEmision>
  <emisor>
    <ruc>${company.ruc ?? ''}</ruc>
    <razonSocial>${escapeXml(company.razon_social ?? company.name ?? '')}</razonSocial>
    <direccion>${escapeXml(company.direccion ?? company.address ?? '')}</direccion>
  </emisor>
  <receptor>
    <tipoDocumento>${invoice.customer_document_type ?? ''}</tipoDocumento>
    <numeroDocumento>${invoice.customer_document_number ?? ''}</numeroDocumento>
  </receptor>
  <documentoModificado>
    <tipoDoc>${invoice.comprobante_type}</tipoDoc>
    <serie>${invoice.serie}</serie>
    <numero>${invoice.numero}</numero>
  </documentoModificado>
  <motivoCodigo>${ncData.motivo_code}</motivoCodigo>
  <motivoDescripcion>${escapeXml(ncData.motivo_descripcion)}</motivoDescripcion>
  <items>${itemsXml}
  </items>
  <totales>
    <subtotal>${sale.subtotal}</subtotal>
    <igv>${sale.igv}</igv>
    <total>${sale.total}</total>
  </totales>
</comprobante>`;
}

// ─── Servicio de Facturación ──────────────────────────────────────────────────

/**
 * Emite un comprobante para una venta.
 *
 * RF-29 (Idempotencia): si ya existe un invoice para sale_id, retorna el
 * existente con { alreadyExists: true } sin crear duplicados ni contactar el PSE.
 *
 * RF-28 (Contingencia): si el PSE no responde, el invoice queda en estado
 * 'contingency' y la función retorna éxito igual (no es un error 500).
 *
 * @param {{ sale_id, comprobante_type, customer_document_type, customer_document_number, simulatePseDown }} param
 * @param {number} companyId
 */
export async function createInvoice({
  sale_id,
  comprobante_type,
  customer_document_type,
  customer_document_number,
  simulatePseDown = false,
}, companyId) {
  // Validaciones previas
  if (!sale_id) throw new AppError('"sale_id" es obligatorio.', 'MISSING_FIELD', 422);
  if (!comprobante_type) throw new AppError('"comprobante_type" es obligatorio.', 'MISSING_FIELD', 422);

  const client = await pool.connect();
  let invoice;
  let sale;
  const serie = comprobante_type === 'factura' ? 'F001' : 'B001';

  try {
    await client.query('BEGIN');

    // a) Verificar datos fiscales de la empresa
    const { rows: compRows } = await client.query(
      `SELECT ruc, razon_social, direccion FROM companies WHERE id = $1`,
      [companyId]
    );
    const company = compRows[0];
    if (!company || !company.ruc || !company.razon_social || !company.ruc.trim() || !company.razon_social.trim()) {
      throw new AppError(
        'Configura el RUC y la razón social de tu taller en Configuración antes de emitir comprobantes.',
        'MISSING_COMPANY_TAX_DATA',
        422
      );
    }

    // b) Buscar la venta con company_id
    const { rows: saleRows } = await client.query(
      `SELECT * FROM sales WHERE id = $1 AND company_id = $2`,
      [sale_id, companyId]
    );
    if (!saleRows[0]) {
      throw new AppError(`Venta con id ${sale_id} no encontrada.`, 'SALE_NOT_FOUND', 404);
    }
    sale = saleRows[0];

    if (sale.status === 'voided') {
      throw new AppError(
        `No se puede emitir comprobante para la venta #${sale_id} porque está anulada.`,
        'CANNOT_INVOICE_VOIDED_SALE',
        422
      );
    }

    // c) RF-29: verificar idempotencia — ya existe un invoice para este sale_id en la empresa
    const { rows: existing } = await client.query(
      `SELECT * FROM invoices WHERE sale_id = $1 AND company_id = $2`,
      [sale_id, companyId]
    );
    if (existing[0]) {
      await client.query('COMMIT');
      return { ...existing[0], alreadyExists: true };
    }

    // Traer ítems de la venta expandidos para el XML
    const { rows: saleItems } = await client.query(
      `SELECT
         si.quantity, si.unit_price, si.subtotal,
         p.name AS product_name,
         k.name AS kit_name
       FROM   sale_items si
       LEFT JOIN products p ON p.id = si.product_id
       LEFT JOIN kits     k ON k.id = si.kit_id
       WHERE  si.sale_id = $1`,
      [sale_id]
    );
    sale.items = saleItems;

    // Obtener correlativo atómico por empresa y serie
    const { rows: seriesRows } = await client.query(
      `INSERT INTO invoice_series (company_id, serie, last_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (company_id, serie)
       DO UPDATE SET last_number = invoice_series.last_number + 1
       RETURNING last_number`,
      [companyId, serie]
    );
    const numero = seriesRows[0].last_number;

    // d) Insertar el invoice con numero y estado='pending'
    const { rows: invoiceRows } = await client.query(
      `INSERT INTO invoices
         (company_id, sale_id, comprobante_type, serie, numero, customer_document_type,
          customer_document_number, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING *`,
      [
        companyId,
        sale_id,
        comprobante_type,
        serie,
        numero,
        customer_document_type ?? null,
        customer_document_number ?? null,
      ]
    );
    invoice = invoiceRows[0];

    // Construir XML con el número correlativo ya asignado y los datos del emisor
    const xml = buildSimplifiedXml(sale, {
      comprobante_type,
      serie,
      numero: invoice.numero,
      customer_document_type,
      customer_document_number,
    }, company);

    // Guardar el XML en la fila
    await client.query(
      `UPDATE invoices SET xml_content = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
      [xml, invoice.id, companyId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // e) Enviar al PSE simulado (fuera de la transacción del correlativo)
  let updatedInvoice;
  try {
    const pseResult = await sendComprobante({ xml: invoice.xml_content, simulatePseDown });

    const { rows } = await pool.query(
      `UPDATE invoices
       SET estado = 'accepted', cdr_response = $1, is_contingency = false, updated_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [JSON.stringify(pseResult.cdr), invoice.id, companyId]
    );
    updatedInvoice = rows[0];

  } catch (pseErr) {
    if (pseErr.code === 'PSE_UNAVAILABLE') {
      // RF-28: contingencia — la operación es exitosa, el comprobante existe
      const { rows } = await pool.query(
        `UPDATE invoices
         SET estado = 'contingency', is_contingency = true,
             cdr_response = $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [JSON.stringify({ error: pseErr.message }), invoice.id, companyId]
      );
      updatedInvoice = rows[0];
    } else {
      // Error inesperado del PSE — sí es un error real
      throw pseErr;
    }
  }

  return updatedInvoice;
}

/**
 * Reintenta el envío al PSE de un comprobante en contingencia para la empresa especificada.
 * @param {number|string} id  ID del invoice
 * @param {number} companyId
 */
export async function retryContingency(id, companyId, userId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    if (!rows[0]) {
      throw new AppError(`Invoice #${id} no encontrado.`, 'INVOICE_NOT_FOUND', 404);
    }
    const invoice = rows[0];

    if (invoice.estado !== 'contingency') {
      throw new AppError(
        `El invoice #${id} tiene estado '${invoice.estado}'. Solo se pueden reintentar comprobantes en contingencia.`,
        'NOTHING_TO_RETRY',
        422
      );
    }

    // Reenviar sin simulatePseDown — se asume que el PSE ya está disponible
    let updatedInvoice;
    try {
      const pseResult = await sendComprobante({ xml: invoice.xml_content, simulatePseDown: false });

      const { rows: updated } = await client.query(
        `UPDATE invoices
         SET estado = 'accepted', cdr_response = $1, is_contingency = false, updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [JSON.stringify(pseResult.cdr), id, companyId]
      );
      updatedInvoice = updated[0];

    } catch (pseErr) {
      if (pseErr.code === 'PSE_UNAVAILABLE') {
        // Sigue sin poder enviar — se mantiene en contingency
        const { rows: updated } = await client.query(
          `UPDATE invoices
           SET cdr_response = $1, updated_at = NOW()
           WHERE id = $2 AND company_id = $3
           RETURNING *`,
          [JSON.stringify({ error: pseErr.message, retried_at: new Date().toISOString() }), id, companyId]
        );
        updatedInvoice = updated[0];
      } else {
        throw pseErr;
      }
    }

    await logAudit(client, {
      companyId,
      userId,
      entity: 'invoice',
      entityId: Number(id),
      action: 'retry_contingency',
      changes: {
        estado: { old: 'contingency', new: updatedInvoice.estado },
      },
    });

    await client.query('COMMIT');
    return updatedInvoice;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lista todos los comprobantes en estado 'contingency' para la empresa.
 * @param {number} companyId
 */
export async function getPendingContingency(companyId) {
  const { rows } = await pool.query(
    `SELECT i.*, s.total AS sale_total, s.customer_name
     FROM   invoices i
     JOIN   sales    s ON s.id = i.sale_id
     WHERE  i.company_id = $1 AND i.estado = 'contingency'
     ORDER  BY i.created_at ASC`,
    [companyId]
  );
  return rows;
}

/**
 * RF-30: retorna solo el estado del comprobante.
 * @param {number|string} id
 * @param {number} companyId
 */
export async function getStatus(id, companyId) {
  const { rows } = await pool.query(
    `SELECT id, estado, is_contingency FROM invoices WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!rows[0]) throw new AppError(`Invoice #${id} no encontrado.`, 'INVOICE_NOT_FOUND', 404);
  return rows[0];
}

/**
 * Retorna un invoice por id con join a sales.
 * @param {number|string} id
 * @param {number} companyId
 */
export async function getById(id, companyId) {
  const { rows } = await pool.query(
    `SELECT i.*, s.total AS sale_total, s.subtotal AS sale_subtotal,
            s.igv AS sale_igv, s.customer_name, s.payment_method
     FROM   invoices i
     JOIN   sales    s ON s.id = i.sale_id
     WHERE  i.id = $1 AND i.company_id = $2`,
    [id, companyId]
  );
  return rows[0] ?? null;
}

/**
 * Lista todos los comprobantes de la empresa. Filtra por estado si se envía.
 * @param {{ estado?: string }} options
 * @param {number} companyId
 */
export async function getAll({ estado } = {}, companyId) {
  let query;
  let params;

  if (estado && estado.trim() !== '') {
    query = `
      SELECT i.*, s.total AS sale_total, s.customer_name,
             CASE
               WHEN cn.id IS NOT NULL THEN json_build_object(
                 'id', cn.id,
                 'serie', cn.serie,
                 'numero', cn.numero,
                 'estado', cn.estado,
                 'motivo_code', cn.motivo_code,
                 'motivo_descripcion', cn.motivo_descripcion,
                 'created_at', cn.created_at
               )
               ELSE NULL
             END AS credit_note
      FROM   invoices i
      JOIN   sales    s  ON s.id = i.sale_id
      LEFT JOIN credit_notes cn ON cn.invoice_id = i.id AND cn.company_id = i.company_id
      WHERE  i.company_id = $1 AND i.estado = $2
      ORDER  BY i.id ASC
    `;
    params = [companyId, estado.trim()];
  } else {
    query = `
      SELECT i.*, s.total AS sale_total, s.customer_name,
             CASE
               WHEN cn.id IS NOT NULL THEN json_build_object(
                 'id', cn.id,
                 'serie', cn.serie,
                 'numero', cn.numero,
                 'estado', cn.estado,
                 'motivo_code', cn.motivo_code,
                 'motivo_descripcion', cn.motivo_descripcion,
                 'created_at', cn.created_at
               )
               ELSE NULL
             END AS credit_note
      FROM   invoices i
      JOIN   sales    s  ON s.id = i.sale_id
      LEFT JOIN credit_notes cn ON cn.invoice_id = i.id AND cn.company_id = i.company_id
      WHERE  i.company_id = $1
      ORDER  BY i.id ASC
    `;
    params = [companyId];
  }

  const { rows } = await pool.query(query, params);
  return rows;
}

/**
 * Retorna los datos estructurados del ticket para la empresa especificada.
 * @param {number|string} id  ID del invoice
 * @param {number} companyId
 */
export async function getTicketData(id, companyId) {
  const { rows: invRows } = await pool.query(
    `SELECT i.*, s.total, s.subtotal, s.igv, s.igv_rate, s.customer_name,
            s.payment_method, s.created_at AS sale_date,
            c.ruc AS comp_ruc, c.razon_social AS comp_razon_social,
            c.nombre_comercial AS comp_nombre_comercial, c.direccion AS comp_direccion,
            c.telefono AS comp_telefono, c.logo_data AS comp_logo_data
     FROM   invoices i
     JOIN   sales    s ON s.id = i.sale_id
     JOIN   companies c ON c.id = i.company_id
     WHERE  i.id = $1 AND i.company_id = $2`,
    [id, companyId]
  );
  if (!invRows[0]) throw new AppError(`Invoice #${id} no encontrado.`, 'INVOICE_NOT_FOUND', 404);
  const inv = invRows[0];

  // Traer ítems de la venta
  const { rows: items } = await pool.query(
    `SELECT
       si.quantity, si.unit_price, si.subtotal,
       COALESCE(p.name, k.name) AS description
     FROM   sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     LEFT JOIN kits     k ON k.id = si.kit_id
     WHERE  si.sale_id = $1
     ORDER  BY si.id ASC`,
    [inv.sale_id]
  );

  // Traer pagos de la venta (RF-24)
  const { rows: payments } = await pool.query(
    `SELECT method, amount, reference, cash_received, change_given
     FROM   sale_payments
     WHERE  sale_id = $1 AND company_id = $2
     ORDER  BY id ASC`,
    [inv.sale_id, companyId]
  );

  return {
    business: {
      name:             inv.comp_nombre_comercial || inv.comp_razon_social || 'MotoTrack',
      razon_social:     inv.comp_razon_social,
      nombre_comercial: inv.comp_nombre_comercial,
      ruc:              inv.comp_ruc,
      address:          inv.comp_direccion,
      phone:            inv.comp_telefono,
      logo_data:        inv.comp_logo_data,
    },
    igv_rate: inv.igv_rate != null ? parseFloat(inv.igv_rate) : 0.18,
    comprobante: {
      type:   inv.comprobante_type,
      serie:  inv.serie,
      numero: inv.numero,
      estado: inv.estado,
    },
    customer: {
      name:           inv.customer_name ?? 'Consumidor Final',
      document_type:  inv.customer_document_type,
      document_number: inv.customer_document_number,
    },
    sale: {
      date:           inv.sale_date,
      payment_method: inv.payment_method,
      payments,
      items,
      subtotal:       inv.subtotal,
      igv:            inv.igv,
      total:          inv.total,
      igv_rate:       inv.igv_rate != null ? parseFloat(inv.igv_rate) : 0.18,
    },
  };
}

/**
 * Lista todas las notas de crédito de la empresa.
 * @param {number} companyId
 */
export async function listCreditNotes(companyId) {
  const { rows } = await pool.query(
    `SELECT cn.*,
            i.serie AS invoice_serie, i.numero AS invoice_numero, i.comprobante_type,
            s.customer_name
     FROM   credit_notes cn
     JOIN   invoices     i  ON i.id = cn.invoice_id
     JOIN   sales        s  ON s.id = cn.sale_id
     WHERE  cn.company_id = $1
     ORDER  BY cn.id DESC`,
    [companyId]
  );
  return rows;
}

/**
 * Retorna los datos estructurados del ticket de la Nota de Crédito.
 * @param {number|string} id  ID de la credit_note
 * @param {number} companyId
 */
export async function getCreditNoteTicketData(id, companyId) {
  const { rows } = await pool.query(
    `SELECT cn.*,
            i.serie AS inv_serie, i.numero AS inv_numero, i.comprobante_type AS inv_type,
            i.customer_document_type, i.customer_document_number,
            s.total, s.subtotal, s.igv, s.igv_rate, s.customer_name, s.payment_method,
            s.created_at AS sale_date,
            c.ruc AS comp_ruc, c.razon_social AS comp_razon_social,
            c.nombre_comercial AS comp_nombre_comercial, c.direccion AS comp_direccion,
            c.telefono AS comp_telefono, c.logo_data AS comp_logo_data
     FROM   credit_notes cn
     JOIN   invoices     i  ON i.id = cn.invoice_id
     JOIN   sales        s  ON s.id = cn.sale_id
     JOIN   companies    c  ON c.id = cn.company_id
     WHERE  cn.id = $1 AND cn.company_id = $2`,
    [id, companyId]
  );
  if (!rows[0]) throw new AppError(`Nota de crédito #${id} no encontrada.`, 'CREDIT_NOTE_NOT_FOUND', 404);
  const cn = rows[0];

  const { rows: items } = await pool.query(
    `SELECT
       si.quantity, si.unit_price, si.subtotal,
       COALESCE(p.name, k.name) AS description
     FROM   sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     LEFT JOIN kits     k ON k.id = si.kit_id
     WHERE  si.sale_id = $1
     ORDER  BY si.id ASC`,
    [cn.sale_id]
  );

  const { rows: payments } = await pool.query(
    `SELECT method, amount, reference, cash_received, change_given
     FROM   sale_payments
     WHERE  sale_id = $1 AND company_id = $2
     ORDER  BY id ASC`,
    [cn.sale_id, companyId]
  );

  return {
    business: {
      name:             cn.comp_nombre_comercial || cn.comp_razon_social || 'MotoTrack',
      razon_social:     cn.comp_razon_social,
      nombre_comercial: cn.comp_nombre_comercial,
      ruc:              cn.comp_ruc,
      address:          cn.comp_direccion,
      phone:            cn.comp_telefono,
      logo_data:        cn.comp_logo_data,
    },
    credit_note: {
      id:                 cn.id,
      serie:              cn.serie,
      numero:             cn.numero,
      estado:             cn.estado,
      motivo_code:        cn.motivo_code,
      motivo_descripcion: cn.motivo_descripcion,
      created_at:         cn.created_at,
    },
    modified_document: {
      type:   cn.inv_type,
      serie:  cn.inv_serie,
      numero: cn.inv_numero,
    },
    customer: {
      name:            cn.customer_name ?? 'Consumidor Final',
      document_type:   cn.customer_document_type,
      document_number: cn.customer_document_number,
    },
    sale: {
      date:           cn.sale_date,
      payment_method: cn.payment_method,
      payments,
      items,
      subtotal:       cn.subtotal,
      igv:            cn.igv,
      total:          cn.total,
      igv_rate:       cn.igv_rate != null ? parseFloat(cn.igv_rate) : 0.18,
    },
  };
}

/**
 * Reintenta el envío de una Nota de Crédito en contingencia.
 * @param {number|string} id  ID de la credit_note
 * @param {number} companyId
 * @param {number} userId
 */
export async function retryCreditNoteContingency(id, companyId, userId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM credit_notes WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    if (!rows[0]) {
      throw new AppError(`Nota de crédito #${id} no encontrada.`, 'CREDIT_NOTE_NOT_FOUND', 404);
    }
    const cn = rows[0];

    if (cn.estado !== 'contingency') {
      throw new AppError(
        `La nota de crédito #${id} tiene estado '${cn.estado}'. Solo se pueden reintentar notas de crédito en contingencia.`,
        'NOTHING_TO_RETRY',
        422
      );
    }

    let updatedCn;
    try {
      const pseResult = await sendComprobante({ xml: cn.xml_content, simulatePseDown: false });

      const { rows: updated } = await client.query(
        `UPDATE credit_notes
         SET estado = 'accepted', cdr_response = $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [JSON.stringify(pseResult.cdr), id, companyId]
      );
      updatedCn = updated[0];

    } catch (pseErr) {
      if (pseErr.code === 'PSE_UNAVAILABLE') {
        const { rows: updated } = await client.query(
          `UPDATE credit_notes
           SET cdr_response = $1, updated_at = NOW()
           WHERE id = $2 AND company_id = $3
           RETURNING *`,
          [JSON.stringify({ error: pseErr.message, retried_at: new Date().toISOString() }), id, companyId]
        );
        updatedCn = updated[0];
      } else {
        throw pseErr;
      }
    }

    await logAudit(client, {
      companyId,
      userId,
      entity: 'credit_note',
      entityId: Number(id),
      action: 'retry_contingency',
      changes: {
        estado: { old: 'contingency', new: updatedCn.estado },
      },
    });

    await client.query('COMMIT');
    return updatedCn;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
