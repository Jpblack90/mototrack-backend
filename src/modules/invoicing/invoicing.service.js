import pool from '../../config/database.js';
import { sendComprobante } from './invoicing.pseClient.js';

// ─── Datos del negocio (hardcodeados para esta fase) ─────────────────────────
// TODO Fase 6: mover a tabla de configuración del sistema y proteger con Auth.
const BUSINESS_INFO = {
  name:    'MotoTrack Taller S.A.C.',
  ruc:     '20123456789',   // RUC ficticio con fines académicos
  address: 'Av. Principal 123, Lima, Perú',
  phone:   '01-234-5678',
};

// ─── Errores controlados ──────────────────────────────────────────────────────

class AppError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
 * @returns {string}
 */
export function buildSimplifiedXml(sale, invoiceData) {
  const { comprobante_type, serie, numero, customer_document_type, customer_document_number } =
    invoiceData;

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
    <ruc>${BUSINESS_INFO.ruc}</ruc>
    <razonSocial>${escapeXml(BUSINESS_INFO.name)}</razonSocial>
    <direccion>${escapeXml(BUSINESS_INFO.address)}</direccion>
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

/** Escapa caracteres especiales XML. */
function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
 */
export async function createInvoice({
  sale_id,
  comprobante_type,
  customer_document_type,
  customer_document_number,
  simulatePseDown = false,
}) {
  // Validaciones previas
  if (!sale_id) throw new AppError('"sale_id" es obligatorio.', 'MISSING_FIELD', 422);
  if (!comprobante_type) throw new AppError('"comprobante_type" es obligatorio.', 'MISSING_FIELD', 422);

  // a) Buscar la venta con sus ítems expandidos
  const { rows: saleRows } = await pool.query(
    `SELECT * FROM sales WHERE id = $1`,
    [sale_id]
  );
  if (!saleRows[0]) {
    throw new AppError(`Venta con id ${sale_id} no encontrada.`, 'SALE_NOT_FOUND', 404);
  }
  const sale = saleRows[0];

  if (sale.status === 'voided') {
    throw new AppError(
      `No se puede emitir comprobante para la venta #${sale_id} porque está anulada.`,
      'CANNOT_INVOICE_VOIDED_SALE',
      422
    );
  }

  // b) RF-29: verificar idempotencia — ya existe un invoice para este sale_id
  const { rows: existing } = await pool.query(
    `SELECT * FROM invoices WHERE sale_id = $1`,
    [sale_id]
  );
  if (existing[0]) {
    return { ...existing[0], alreadyExists: true };
  }

  // Traer ítems de la venta expandidos para el XML
  const { rows: saleItems } = await pool.query(
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

  // Determinar serie por tipo de comprobante
  const serie = comprobante_type === 'factura' ? 'F001' : 'B001';

  // c) Insertar el invoice con estado='pending'
  const { rows: invoiceRows } = await pool.query(
    `INSERT INTO invoices
       (sale_id, comprobante_type, serie, customer_document_type,
        customer_document_number, estado)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING *`,
    [
      sale_id,
      comprobante_type,
      serie,
      customer_document_type ?? null,
      customer_document_number ?? null,
    ]
  );
  let invoice = invoiceRows[0];

  // Construir XML con el número correlativo ya asignado
  const xml = buildSimplifiedXml(sale, {
    comprobante_type,
    serie,
    numero: invoice.numero,
    customer_document_type,
    customer_document_number,
  });

  // Guardar el XML en la fila
  await pool.query(
    `UPDATE invoices SET xml_content = $1, updated_at = NOW() WHERE id = $2`,
    [xml, invoice.id]
  );

  // d) Enviar al PSE simulado
  let updatedInvoice;
  try {
    const pseResult = await sendComprobante({ xml, simulatePseDown });

    const { rows } = await pool.query(
      `UPDATE invoices
       SET estado = 'accepted', cdr_response = $1, is_contingency = false, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(pseResult.cdr), invoice.id]
    );
    updatedInvoice = rows[0];

  } catch (pseErr) {
    if (pseErr.code === 'PSE_UNAVAILABLE') {
      // RF-28: contingencia — la operación es exitosa, el comprobante existe
      const { rows } = await pool.query(
        `UPDATE invoices
         SET estado = 'contingency', is_contingency = true,
             cdr_response = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify({ error: pseErr.message }), invoice.id]
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
 * Reintenta el envío al PSE de un comprobante en contingencia.
 * @param {number|string} id  ID del invoice
 */
export async function retryContingency(id) {
  const { rows } = await pool.query(
    `SELECT * FROM invoices WHERE id = $1`,
    [id]
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

    const { rows: updated } = await pool.query(
      `UPDATE invoices
       SET estado = 'accepted', cdr_response = $1, is_contingency = false, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(pseResult.cdr), id]
    );
    updatedInvoice = updated[0];

  } catch (pseErr) {
    if (pseErr.code === 'PSE_UNAVAILABLE') {
      // Sigue sin poder enviar — se mantiene en contingency
      const { rows: updated } = await pool.query(
        `UPDATE invoices
         SET cdr_response = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify({ error: pseErr.message, retried_at: new Date().toISOString() }), id]
      );
      updatedInvoice = updated[0];
    } else {
      throw pseErr;
    }
  }

  return updatedInvoice;
}

/**
 * Lista todos los comprobantes en estado 'contingency'.
 * Útil para un proceso de reintento en lote (cron job futuro).
 */
export async function getPendingContingency() {
  const { rows } = await pool.query(
    `SELECT i.*, s.total AS sale_total, s.customer_name
     FROM   invoices i
     JOIN   sales    s ON s.id = i.sale_id
     WHERE  i.estado = 'contingency'
     ORDER  BY i.created_at ASC`
  );
  return rows;
}

/**
 * RF-30: retorna solo el estado del comprobante.
 * @param {number|string} id
 */
export async function getStatus(id) {
  const { rows } = await pool.query(
    `SELECT id, estado, is_contingency FROM invoices WHERE id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError(`Invoice #${id} no encontrado.`, 'INVOICE_NOT_FOUND', 404);
  return rows[0];
}

/**
 * Retorna un invoice por id con join a sales.
 * @param {number|string} id
 */
export async function getById(id) {
  const { rows } = await pool.query(
    `SELECT i.*, s.total AS sale_total, s.subtotal AS sale_subtotal,
            s.igv AS sale_igv, s.customer_name, s.payment_method
     FROM   invoices i
     JOIN   sales    s ON s.id = i.sale_id
     WHERE  i.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Lista todos los comprobantes. Filtra por estado si se envía.
 * @param {{ estado?: string }} options
 */
export async function getAll({ estado } = {}) {
  let query;
  let params;

  if (estado && estado.trim() !== '') {
    query = `
      SELECT i.*, s.total AS sale_total, s.customer_name
      FROM   invoices i
      JOIN   sales    s ON s.id = i.sale_id
      WHERE  i.estado = $1
      ORDER  BY i.id ASC
    `;
    params = [estado.trim()];
  } else {
    query = `
      SELECT i.*, s.total AS sale_total, s.customer_name
      FROM   invoices i
      JOIN   sales    s ON s.id = i.sale_id
      ORDER  BY i.id ASC
    `;
    params = [];
  }

  const { rows } = await pool.query(query, params);
  return rows;
}

/**
 * Retorna los datos estructurados del ticket, listos para que el FRONTEND
 * arme e imprima el comprobante físico o en PDF.
 *
 * ── Listo para consumir desde la futura pantalla de impresión ──
 *    El backend solo prepara los datos; la impresión/renderizado ocurre
 *    en el cliente (React Web o React Native) en la Fase 7/8.
 *
 * @param {number|string} id  ID del invoice
 */
export async function getTicketData(id) {
  const { rows: invRows } = await pool.query(
    `SELECT i.*, s.total, s.subtotal, s.igv, s.customer_name,
            s.payment_method, s.created_at AS sale_date
     FROM   invoices i
     JOIN   sales    s ON s.id = i.sale_id
     WHERE  i.id = $1`,
    [id]
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

  return {
    business: BUSINESS_INFO,
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
      items,
      subtotal:       inv.subtotal,
      igv:            inv.igv,
      total:          inv.total,
    },
  };
}
