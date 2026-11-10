import pool from '../../config/database.js';
import { logAudit } from '../../shared/audit.js';
import { decrementStock, restoreStock } from '../inventory/inventory.service.js';
import { buildCreditNoteXml, buildPseDocument } from '../invoicing/invoicing.service.js';
import { getPseProvider } from '../invoicing/pse/index.js';
import { sendComprobante } from '../invoicing/invoicing.pseClient.js';
import { testHooksEnabled } from '../../shared/utils/testHooks.js';

// ─── Errores controlados ──────────────────────────────────────────────────────

class AppError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ─── Kits ─────────────────────────────────────────────────────────────────────

/**
 * Crea un kit y sus ítems componentes en una transacción.
 *
 * @param {{ name, description, kit_price, items: Array<{product_id, quantity}> }} data
 * @param {number} companyId
 */
export async function createKit({ name, description, kit_price, items }, companyId) {
  if (!name || String(name).trim() === '') {
    throw new AppError('"name" es obligatorio para crear un kit.', 'MISSING_FIELD', 422);
  }
  if (kit_price === undefined || kit_price === null) {
    throw new AppError('"kit_price" es obligatorio.', 'MISSING_FIELD', 422);
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new AppError('Un kit debe tener al menos 1 producto componente en "items".', 'MISSING_FIELD', 422);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: kitRows } = await client.query(
      `INSERT INTO kits (company_id, name, description, kit_price)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [companyId, name.trim(), description ?? null, Number(kit_price)]
    );
    const kit = kitRows[0];

    for (const item of items) {
      if (!item.product_id || !item.quantity || Number(item.quantity) < 1) {
        throw new AppError(
          'Cada ítem del kit debe tener "product_id" y "quantity" >= 1.',
          'INVALID_FIELD',
          422
        );
      }
      // Validar que el producto pertenezca a la empresa
      const { rows: prodRows } = await client.query(
        `SELECT id FROM products WHERE id = $1 AND company_id = $2 AND is_active = true`,
        [item.product_id, companyId]
      );
      if (!prodRows[0]) {
        throw new AppError(
          `Producto con id ${item.product_id} no encontrado o inactivo.`,
          'PRODUCT_NOT_FOUND',
          404
        );
      }

      await client.query(
        `INSERT INTO kit_items (kit_id, product_id, quantity)
         VALUES ($1, $2, $3)`,
        [kit.id, item.product_id, Number(item.quantity)]
      );
    }

    await client.query('COMMIT');
    return kit;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lista todos los kits activos con sus ítems expandidos (nombre del producto incluido).
 * @param {number} companyId
 */
export async function getAllKits(companyId) {
  const { rows: kits } = await pool.query(
    `SELECT * FROM kits WHERE company_id = $1 AND is_active = true ORDER BY id ASC`,
    [companyId]
  );

  // Para cada kit, trae sus componentes con nombre del producto
  const result = await Promise.all(
    kits.map(async (kit) => {
      const { rows: kitItems } = await pool.query(
        `SELECT ki.id, ki.quantity, p.id AS product_id, p.name AS product_name,
                p.sku, p.stock
         FROM   kit_items ki
         JOIN   products  p  ON p.id = ki.product_id
         WHERE  ki.kit_id = $1`,
        [kit.id]
      );
      return { ...kit, items: kitItems };
    })
  );

  return result;
}

// ─── Ventas ───────────────────────────────────────────────────────────────────

/**
 * Crea una venta con transacción real y soporte para pagos mixtos (RF-24).
 *
 * Flujo:
 *   BEGIN → INSERT sales → por cada item:
 *     - producto directo: decrementStock + INSERT sale_items
 *     - kit: por cada componente decrementStock + INSERT sale_items (1 línea por kit)
 *   → recalcula subtotal/igv/total → valida pagos (en céntimos) → INSERT sale_payments
 *   → UPDATE sales → COMMIT
 *   Si cualquier paso falla: ROLLBACK + release client.
 *
 * @param {{ customer_name, work_order_id, payment_method, payments, items: Array }} data
 * @param {number} companyId
 */
export async function createSale({ customer_name, work_order_id, payment_method, payments, items }, companyId) {
  const validMethods = ['efectivo', 'tarjeta', 'yape', 'plin'];

  // Validar método(s) de pago antes de abrir la transacción
  if (!payments && (!payment_method || String(payment_method).trim() === '')) {
    throw new AppError('Debe especificar "payment_method" o "payments".', 'MISSING_FIELD', 422);
  }

  if (payments !== undefined) {
    if (!Array.isArray(payments) || payments.length === 0 || payments.length > 4) {
      throw new AppError('El campo "payments" debe ser un arreglo de 1 a 4 pagos.', 'INVALID_FIELD', 422);
    }

    let cashCount = 0;
    for (const p of payments) {
      if (!p || typeof p !== 'object') {
        throw new AppError('Cada elemento de "payments" debe ser un objeto válido.', 'INVALID_FIELD', 422);
      }
      if (!p.method || !validMethods.includes(p.method)) {
        throw new AppError(
          `"method" en pagos debe ser uno de: ${validMethods.join(', ')}.`,
          'INVALID_FIELD',
          422
        );
      }
      if (p.amount === undefined || p.amount === null || isNaN(Number(p.amount)) || Number(p.amount) <= 0) {
        throw new AppError('Cada pago debe tener un "amount" numérico mayor a 0.', 'INVALID_FIELD', 422);
      }
      if (p.reference && String(p.reference).length > 60) {
        throw new AppError('El campo "reference" no puede exceder 60 caracteres.', 'INVALID_FIELD', 422);
      }
      if (p.method === 'efectivo') {
        cashCount++;
        if (cashCount > 1) {
          throw new AppError('Solo se permite un pago en efectivo por venta.', 'INVALID_FIELD', 422);
        }
      } else {
        if (p.cash_received !== undefined && p.cash_received !== null && p.cash_received !== '') {
          throw new AppError('Solo el pago en efectivo acepta monto recibido.', 'INVALID_FIELD', 422);
        }
      }
    }
  } else {
    // Formato anterior
    if (!validMethods.includes(payment_method)) {
      throw new AppError(
        `"payment_method" debe ser uno de: ${validMethods.join(', ')}.`,
        'INVALID_FIELD',
        422
      );
    }
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new AppError('La venta debe incluir al menos un ítem en "items".', 'MISSING_FIELD', 422);
  }

  // Validar estructura de cada ítem antes de abrir la transacción
  for (const item of items) {
    const hasProduct = item.product_id != null;
    const hasKit = item.kit_id != null;
    if (hasProduct && hasKit) {
      throw new AppError(
        'Cada ítem debe tener "product_id" O "kit_id", nunca ambos.',
        'INVALID_ITEM',
        422
      );
    }
    if (!hasProduct && !hasKit) {
      throw new AppError(
        'Cada ítem debe tener "product_id" o "kit_id".',
        'INVALID_ITEM',
        422
      );
    }
    if (!item.quantity || Number(item.quantity) < 1) {
      throw new AppError('"quantity" debe ser >= 1 en cada ítem.', 'INVALID_FIELD', 422);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Obtener la tasa de IGV configurada para la empresa
    const { rows: compRows } = await client.query(
      `SELECT igv_rate FROM companies WHERE id = $1`,
      [companyId]
    );
    const companyIgvRate = compRows[0] && compRows[0].igv_rate != null ? Number(compRows[0].igv_rate) : 0.18;

    // Validar orden de trabajo si fue especificada
    if (work_order_id) {
      const { rows: woRows } = await client.query(
        `SELECT id FROM work_orders WHERE id = $1 AND company_id = $2`,
        [work_order_id, companyId]
      );
      if (!woRows[0]) {
        throw new AppError(
          `Orden de trabajo #${work_order_id} no encontrada.`,
          'WORK_ORDER_NOT_FOUND',
          404
        );
      }
    }

    // Método provisional para el INSERT inicial
    const initialPaymentMethod = payments
      ? (payments.length === 1 ? payments[0].method : 'mixto')
      : payment_method;

    // a) INSERT inicial en sales (totales en 0, se actualizan al final)
    const { rows: saleRows } = await client.query(
      `INSERT INTO sales (company_id, customer_name, work_order_id, payment_method, subtotal, igv, total, igv_rate)
       VALUES ($1, $2, $3, $4, 0, 0, 0, $5) RETURNING id`,
      [companyId, customer_name ?? null, work_order_id ?? null, initialPaymentMethod, companyIgvRate]
    );
    const saleId = saleRows[0].id;

    let subtotalTotal = 0;

    // b) Procesar cada ítem
    // Mapa para registrar el stock antes y después de cada producto afectado en esta venta
    const stockTracker = new Map();

    for (const item of items) {
      const qty = Number(item.quantity);

      if (item.product_id != null) {
        // ── Producto directo ──────────────────────────────────────────────────
        const { rows: prodRows } = await client.query(
          `SELECT id, name, sale_price FROM products WHERE id = $1 AND company_id = $2 AND is_active = true`,
          [item.product_id, companyId]
        );
        if (!prodRows[0]) {
          throw new AppError(
            `Producto con id ${item.product_id} no encontrado o inactivo.`,
            'PRODUCT_NOT_FOUND',
            404
          );
        }
        const product = prodRows[0];

        const decRes = await decrementStock(client, product.id, qty, companyId);
        if (!stockTracker.has(decRes.id)) {
          stockTracker.set(decRes.id, {
            id: decRes.id,
            name: decRes.name,
            sku: decRes.sku,
            initial_stock: decRes.stock_before,
            final_stock: decRes.stock_after,
            min_stock: decRes.min_stock,
          });
        } else {
          stockTracker.get(decRes.id).final_stock = decRes.stock_after;
        }

        const unitPrice = Number(product.sale_price);
        const lineSubtotal = +(unitPrice * qty).toFixed(2);

        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal)
           VALUES ($1, $2, $3, $4, $5)`,
          [saleId, product.id, qty, unitPrice, lineSubtotal]
        );

        subtotalTotal += lineSubtotal;

      } else {
        // ── Kit ───────────────────────────────────────────────────────────────
        const { rows: kitRows } = await client.query(
          `SELECT * FROM kits WHERE id = $1 AND company_id = $2 AND is_active = true`,
          [item.kit_id, companyId]
        );
        if (!kitRows[0]) {
          throw new AppError(
            `Kit con id ${item.kit_id} no encontrado o inactivo.`,
            'KIT_NOT_FOUND',
            404
          );
        }
        const kit = kitRows[0];

        // Traer componentes del kit
        const { rows: components } = await client.query(
          `SELECT product_id, quantity FROM kit_items WHERE kit_id = $1`,
          [kit.id]
        );
        if (components.length === 0) {
          throw new AppError(
            `El kit con id ${kit.id} no tiene productos componentes definidos.`,
            'KIT_EMPTY',
            422
          );
        }

        // Descontar stock de cada componente
        for (const comp of components) {
          const compDecRes = await decrementStock(client, comp.product_id, comp.quantity * qty, companyId);
          if (!stockTracker.has(compDecRes.id)) {
            stockTracker.set(compDecRes.id, {
              id: compDecRes.id,
              name: compDecRes.name,
              sku: compDecRes.sku,
              initial_stock: compDecRes.stock_before,
              final_stock: compDecRes.stock_after,
              min_stock: compDecRes.min_stock,
            });
          } else {
            stockTracker.get(compDecRes.id).final_stock = compDecRes.stock_after;
          }
        }

        // Una sola línea de sale_items por kit vendido
        const unitPrice = Number(kit.kit_price);
        const lineSubtotal = +(unitPrice * qty).toFixed(2);

        await client.query(
          `INSERT INTO sale_items (sale_id, kit_id, quantity, unit_price, subtotal)
           VALUES ($1, $2, $3, $4, $5)`,
          [saleId, kit.id, qty, unitPrice, lineSubtotal]
        );

        subtotalTotal += lineSubtotal;
      }
    }

    // Calcular qué productos cruzaron el umbral de stock mínimo por efecto de ESTA venta
    const stockAlerts = [];
    for (const entry of stockTracker.values()) {
      if (entry.initial_stock > entry.min_stock && entry.final_stock <= entry.min_stock) {
        stockAlerts.push({
          id: entry.id,
          name: entry.name,
          sku: entry.sku,
          stock: entry.final_stock,
          min_stock: entry.min_stock,
        });
      }
    }

    // c) Calcular totales usando el IGV configurado de la empresa
    const igv   = +(subtotalTotal * companyIgvRate).toFixed(2);
    const total = +(subtotalTotal + igv).toFixed(2);

    // d) Resolver y validar pagos (en céntimos exactos)
    const effectivePayments = payments !== undefined
      ? payments
      : [{ method: payment_method, amount: total }];

    const totalCents = Math.round(total * 100);
    const sumPaymentsCents = effectivePayments.reduce(
      (acc, p) => acc + Math.round(Number(p.amount) * 100),
      0
    );

    if (totalCents !== sumPaymentsCents) {
      const sumFormatted = (sumPaymentsCents / 100).toFixed(2);
      const totalFormatted = total.toFixed(2);
      throw new AppError(
        `Los pagos suman S/ ${sumFormatted} y el total es S/ ${totalFormatted}.`,
        'PAYMENT_MISMATCH',
        422
      );
    }

    // Método final para la tabla sales ('efectivo', 'tarjeta', etc., o 'mixto')
    const finalPaymentMethod = effectivePayments.length === 1
      ? effectivePayments[0].method
      : 'mixto';

    // e) Actualizar sales con los totales reales y payment_method final
    const { rows: updatedSale } = await client.query(
      `UPDATE sales
       SET payment_method = $1, subtotal = $2, igv = $3, total = $4, igv_rate = $5
       WHERE id = $6 AND company_id = $7
       RETURNING *`,
      [finalPaymentMethod, subtotalTotal.toFixed(2), igv, total, companyIgvRate, saleId, companyId]
    );

    // f) Insertar líneas en sale_payments
    const insertedPayments = [];
    for (const p of effectivePayments) {
      const amountNum = +(Number(p.amount)).toFixed(2);
      let cashReceived = null;
      let changeGiven = null;

      if (p.method === 'efectivo') {
        if (p.cash_received !== undefined && p.cash_received !== null && p.cash_received !== '') {
          const cashReceivedNum = Number(p.cash_received);
          const cashReceivedCents = Math.round(cashReceivedNum * 100);
          const amountCents = Math.round(amountNum * 100);

          if (cashReceivedCents < amountCents) {
            throw new AppError(
              'El monto recibido en efectivo no puede ser menor que el monto a pagar.',
              'INVALID_FIELD',
              422
            );
          }
          cashReceived = +cashReceivedNum.toFixed(2);
          changeGiven = +((cashReceivedCents - amountCents) / 100).toFixed(2);
        }
      }

      const ref = p.reference ? String(p.reference).trim() : null;

      const { rows: payRows } = await client.query(
        `INSERT INTO sale_payments (company_id, sale_id, method, amount, reference, cash_received, change_given)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, method, amount, reference, cash_received, change_given, created_at`,
        [companyId, saleId, p.method, amountNum, ref, cashReceived, changeGiven]
      );
      insertedPayments.push(payRows[0]);
    }

    await client.query('COMMIT');
    return { ...updatedSale[0], payments: insertedPayments, stock_alerts: stockAlerts };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err; // el controller lo captura y responde
  } finally {
    client.release();
  }
}

/**
 * Lista todas las ventas de la empresa. Filtra por status si se envía.
 * @param {{ status?: string }} options
 * @param {number} companyId
 */
export async function getAll({ status } = {}, companyId) {
  let query;
  let params;

  if (status && status.trim() !== '') {
    query = `SELECT * FROM sales WHERE company_id = $1 AND status = $2 ORDER BY id ASC`;
    params = [companyId, status.trim()];
  } else {
    query = `SELECT * FROM sales WHERE company_id = $1 ORDER BY id ASC`;
    params = [companyId];
  }

  const { rows } = await pool.query(query, params);
  return rows;
}

/**
 * Retorna una venta por id y empresa con sus ítems expandidos (nombre de producto/kit).
 * @param {number|string} id
 * @param {number} companyId
 * @returns {object|null}
 */
export async function getById(id, companyId) {
  const { rows: saleRows } = await pool.query(
    `SELECT * FROM sales WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!saleRows[0]) return null;

  const sale = saleRows[0];

  const { rows: saleItems } = await pool.query(
    `SELECT
       si.id, si.quantity, si.unit_price, si.subtotal,
       si.product_id, p.name AS product_name, p.sku,
       si.kit_id,   k.name AS kit_name
     FROM   sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     LEFT JOIN kits     k ON k.id = si.kit_id
     WHERE  si.sale_id = $1
     ORDER  BY si.id ASC`,
    [id]
  );

  const { rows: payments } = await pool.query(
    `SELECT method, amount, reference, cash_received, change_given
     FROM   sale_payments
     WHERE  sale_id = $1 AND company_id = $2
     ORDER  BY id ASC`,
    [id, companyId]
  );

  return { ...sale, items: saleItems, payments };
}

/**
 * Anula una venta y restaura el stock de todos sus ítems para la empresa especificada.
 * Si la venta cuenta con un comprobante electrónico aceptado, emite una Nota de Crédito
 * total según el motivo tributario correspondiente (RF-23).
 *
 * @param {number|string} id
 * @param {string|{void_reason: string, motivo_code?: string}} options
 * @param {number}        companyId
 * @param {number|null}   userId
 */
export async function voidSale(id, options, companyId, userId = null) {
  let void_reason;
  let motivo_code = '01';

  if (typeof options === 'object' && options !== null) {
    void_reason = options.void_reason;
    motivo_code = options.motivo_code || '01';
  } else {
    void_reason = options;
  }

  if (!void_reason || String(void_reason).trim() === '') {
    throw new AppError('"void_reason" es obligatorio para anular una venta.', 'MISSING_FIELD', 422);
  }

  if (!['01', '02', '06'].includes(motivo_code)) {
    throw new AppError('El motivo de anulación es inválido. Debe ser 01, 02 o 06.', 'INVALID_FIELD', 422);
  }

  const client = await pool.connect();
  let createdNc = null;
  let updatedSale = null;
  let company = null;
  let invoice = null;
  let sale = null;
  let saleItemsFull = [];

  try {
    await client.query('BEGIN');

    // 1. Verificar existencia y estado de la venta
    const { rows: saleRows } = await client.query(
      `SELECT * FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    if (!saleRows[0]) {
      throw new AppError(`Venta con id ${id} no encontrada.`, 'SALE_NOT_FOUND', 404);
    }
    sale = saleRows[0];
    if (sale.status === 'voided') {
      throw new AppError(`La venta #${id} ya estaba anulada.`, 'ALREADY_VOIDED', 409);
    }

    // 2. Verificar comprobante asociado
    const { rows: invoiceRows } = await client.query(
      `SELECT * FROM invoices WHERE sale_id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    invoice = invoiceRows[0] ?? null;

    if (invoice) {
      if (invoice.estado === 'pending' || invoice.estado === 'contingency') {
        const fullSerieNumero = `${invoice.serie}-${String(invoice.numero).padStart(8, '0')}`;
        throw new AppError(
          `El comprobante ${fullSerieNumero} aún no fue aceptado por SUNAT. Reintenta su envío antes de anular.`,
          'INVOICE_NOT_ACCEPTED',
          409
        );
      }

      if (invoice.estado === 'accepted') {
        if (invoice.comprobante_type === 'boleta' && motivo_code === '02') {
          throw new AppError(
            "El motivo '02' (Anulación por error en el RUC) solo aplica a facturas.",
            'INVALID_MOTIVO_FOR_BOLETA',
            422
          );
        }

        // Datos de la empresa para series y XML
        const { rows: compRows } = await client.query(
          `SELECT id, ruc, razon_social, direccion, nombre_comercial, pse_provider, pse_url, pse_token_enc,
                  series_boleta, series_factura, series_nc_boleta, series_nc_factura
           FROM companies WHERE id = $1`,
          [companyId]
        );
        company = compRows[0] ?? {};

        const ncSerie = invoice.comprobante_type === 'factura'
          ? (company.series_nc_factura || 'FC01')
          : (company.series_nc_boleta || 'BC01');

        // Correlativo atómico
        const { rows: seriesRows } = await client.query(
          `INSERT INTO invoice_series (company_id, serie, last_number)
           VALUES ($1, $2, 1)
           ON CONFLICT (company_id, serie)
           DO UPDATE SET last_number = invoice_series.last_number + 1
           RETURNING last_number`,
          [companyId, ncSerie]
        );
        const ncNumero = seriesRows[0].last_number;

        // Items de la venta para XML
        const { rows: itemsDb } = await client.query(
          `SELECT si.quantity, si.unit_price, si.subtotal,
                  p.name AS product_name,
                  k.name AS kit_name
           FROM   sale_items si
           LEFT JOIN products p ON p.id = si.product_id
           LEFT JOIN kits     k ON k.id = si.kit_id
           WHERE  si.sale_id = $1`,
          [id]
        );
        saleItemsFull = itemsDb;

        const xmlContent = buildCreditNoteXml({
          sale: { ...sale, items: saleItemsFull },
          invoice,
          ncData: {
            serie: ncSerie,
            numero: ncNumero,
            motivo_code,
            motivo_descripcion: void_reason.trim(),
          },
          company,
        });

        const { rows: ncInsertRows } = await client.query(
          `INSERT INTO credit_notes
             (company_id, invoice_id, sale_id, serie, numero, motivo_code, motivo_descripcion,
              subtotal, igv, total, xml_content, estado, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)
           RETURNING *`,
          [
            companyId,
            invoice.id,
            id,
            ncSerie,
            ncNumero,
            motivo_code,
            void_reason.trim(),
            sale.subtotal,
            sale.igv,
            sale.total,
            xmlContent,
            userId,
          ]
        );
        createdNc = ncInsertRows[0];
      }
      // Si invoice.estado === 'rejected', anula como venta sin comprobante (createdNc queda en null)
    }

    // 3. Restaurar stock
    const { rows: saleItems } = await client.query(
      `SELECT si.product_id, si.kit_id, si.quantity FROM sale_items AS si WHERE si.sale_id = $1`,
      [id]
    );

    const restoredStock = [];
    for (const item of saleItems) {
      if (item.product_id != null) {
        await restoreStock(client, item.product_id, item.quantity, companyId);
        restoredStock.push({ product_id: item.product_id, quantity: item.quantity });
      } else if (item.kit_id != null) {
        const { rows: components } = await client.query(
          `SELECT product_id, quantity FROM kit_items WHERE kit_id = $1`,
          [item.kit_id]
        );
        for (const comp of components) {
          const qtyToRestore = comp.quantity * item.quantity;
          await restoreStock(client, comp.product_id, qtyToRestore, companyId);
          restoredStock.push({ product_id: comp.product_id, quantity: qtyToRestore, from_kit_id: item.kit_id });
        }
      }
    }

    // 4. Marcar la venta como anulada
    const { rows: updated } = await client.query(
      `UPDATE sales
       SET status = 'voided', void_reason = $1, voided_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [void_reason.trim(), id, companyId]
    );
    updatedSale = updated[0];

    // 5. Registrar en auditoría la anulación de la venta y la NC si aplica
    await logAudit(client, {
      companyId,
      userId,
      entity: 'sale',
      entityId: Number(id),
      action: 'void',
      changes: {
        void_reason: void_reason.trim(),
        motivo_code,
        restored_stock: restoredStock,
        credit_note: createdNc ? { id: createdNc.id, serie: createdNc.serie, numero: createdNc.numero } : null,
      },
    });

    // Punto de prueba de rollback (solo si test hooks están habilitados)
    if (
      testHooksEnabled() &&
      (process.env.FORCE_VOID_FAIL === '1' || options?.forceFail === true)
    ) {
      throw new Error('[TEST] Error forzado después de insertar la NC y antes del COMMIT');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // 6. Fuera de la transacción: enviar NC al PSE según proveedor configurado
  if (createdNc && company) {
    const provider = getPseProvider(company);
    const pseDoc = buildPseDocument({
      comprobanteType: invoice?.comprobante_type,
      serie: createdNc.serie,
      numero: createdNc.numero,
      sale: { ...sale, items: saleItemsFull },
      customerDocType: invoice?.customer_document_type,
      customerDocNumber: invoice?.customer_document_number,
      creditNote: createdNc,
      invoiceModificado: invoice,
    });

    try {
      const pseResult = await provider.send({
        type: 'credit_note',
        company,
        document: pseDoc,
        simulatePseDown: false,
      });

      const finalEstado = pseResult.accepted ? 'accepted' : 'rejected';
      const { rows: updatedNcRows } = await pool.query(
        `UPDATE credit_notes
         SET estado = $1,
             cdr_response = $2,
             pdf_url = $3,
             xml_url = $4,
             hash = $5,
             qr_string = $6,
             updated_at = NOW()
         WHERE id = $7 AND company_id = $8
         RETURNING *`,
        [
          finalEstado,
          JSON.stringify(pseResult.raw ?? { description: pseResult.sunat_description }),
          pseResult.pdf_url ?? null,
          pseResult.xml_url ?? null,
          pseResult.hash ?? null,
          pseResult.qr_string ?? null,
          createdNc.id,
          companyId,
        ]
      );
      createdNc = updatedNcRows[0];
    } catch (pseErr) {
      if (pseErr.code === 'PSE_UNAVAILABLE') {
        const { rows: updatedNcRows } = await pool.query(
          `UPDATE credit_notes
           SET estado = 'contingency', cdr_response = $1, updated_at = NOW()
           WHERE id = $2 AND company_id = $3
           RETURNING *`,
          [JSON.stringify({ error: pseErr.message }), createdNc.id, companyId]
        );
        createdNc = updatedNcRows[0];
      } else {
        throw pseErr;
      }
    }
  }

  return { ...updatedSale, credit_note: createdNc };
}
