import pool from '../../config/database.js';
import { decrementStock, restoreStock } from '../inventory/inventory.service.js';

// ─── Errores controlados ──────────────────────────────────────────────────────

class AppError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const IGV_RATE = 0.18;

// ─── Kits ─────────────────────────────────────────────────────────────────────

/**
 * Crea un kit y sus ítems componentes en una transacción.
 *
 * @param {{ name, description, kit_price, items: Array<{product_id, quantity}> }} data
 */
export async function createKit({ name, description, kit_price, items }) {
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
      `INSERT INTO kits (name, description, kit_price)
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), description ?? null, Number(kit_price)]
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
 */
export async function getAllKits() {
  const { rows: kits } = await pool.query(
    `SELECT * FROM kits WHERE is_active = true ORDER BY id ASC`
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
 * Crea una venta con transacción real.
 *
 * Flujo:
 *   BEGIN → INSERT sales → por cada item:
 *     - producto directo: decrementStock + INSERT sale_items
 *     - kit: por cada componente decrementStock + INSERT sale_items (1 línea por kit)
 *   → recalcula subtotal/igv/total → UPDATE sales → COMMIT
 *   Si cualquier paso falla: ROLLBACK + release client.
 *
 * @param {{ customer_name, work_order_id, payment_method, items: Array }} data
 */
export async function createSale({ customer_name, work_order_id, payment_method, items }) {
  // Validaciones previas a tocar la BD
  if (!payment_method || String(payment_method).trim() === '') {
    throw new AppError('"payment_method" es obligatorio.', 'MISSING_FIELD', 422);
  }
  const validMethods = ['efectivo', 'tarjeta', 'yape', 'plin'];
  if (!validMethods.includes(payment_method)) {
    throw new AppError(
      `"payment_method" debe ser uno de: ${validMethods.join(', ')}.`,
      'INVALID_FIELD',
      422
    );
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

    // a) INSERT inicial en sales (totales en 0, se actualizan al final)
    const { rows: saleRows } = await client.query(
      `INSERT INTO sales (customer_name, work_order_id, payment_method, subtotal, igv, total)
       VALUES ($1, $2, $3, 0, 0, 0) RETURNING id`,
      [customer_name ?? null, work_order_id ?? null, payment_method]
    );
    const saleId = saleRows[0].id;

    let subtotalTotal = 0;

    // b) Procesar cada ítem
    for (const item of items) {
      const qty = Number(item.quantity);

      if (item.product_id != null) {
        // ── Producto directo ──────────────────────────────────────────────────
        const { rows: prodRows } = await client.query(
          `SELECT id, name, sale_price FROM products WHERE id = $1 AND is_active = true`,
          [item.product_id]
        );
        if (!prodRows[0]) {
          throw new AppError(
            `Producto con id ${item.product_id} no encontrado o inactivo.`,
            'PRODUCT_NOT_FOUND',
            404
          );
        }
        const product = prodRows[0];

        await decrementStock(client, product.id, qty);

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
          `SELECT * FROM kits WHERE id = $1 AND is_active = true`,
          [item.kit_id]
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
          await decrementStock(client, comp.product_id, comp.quantity * qty);
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

    // c) Calcular totales — el backend es la única fuente de verdad
    const igv   = +(subtotalTotal * IGV_RATE).toFixed(2);
    const total = +(subtotalTotal + igv).toFixed(2);

    // d) Actualizar sales con los totales reales
    const { rows: updatedSale } = await client.query(
      `UPDATE sales SET subtotal = $1, igv = $2, total = $3 WHERE id = $4 RETURNING *`,
      [subtotalTotal.toFixed(2), igv, total, saleId]
    );

    await client.query('COMMIT');
    return updatedSale[0];

  } catch (err) {
    await client.query('ROLLBACK');
    throw err; // el controller lo captura y responde
  } finally {
    client.release();
  }
}

/**
 * Lista todas las ventas. Filtra por status si se envía.
 * @param {{ status?: string }} options
 */
export async function getAll({ status } = {}) {
  let query;
  let params;

  if (status && status.trim() !== '') {
    query = `SELECT * FROM sales WHERE status = $1 ORDER BY id ASC`;
    params = [status.trim()];
  } else {
    query = `SELECT * FROM sales ORDER BY id ASC`;
    params = [];
  }

  const { rows } = await pool.query(query, params);
  return rows;
}

/**
 * Retorna una venta por id con sus ítems expandidos (nombre de producto/kit).
 * @param {number|string} id
 * @returns {object|null}
 */
export async function getById(id) {
  const { rows: saleRows } = await pool.query(
    `SELECT * FROM sales WHERE id = $1`,
    [id]
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

  return { ...sale, items: saleItems };
}

/**
 * Anula una venta y restaura el stock de todos sus ítems.
 *
 * ⚠️  NOTA FISCAL IMPORTANTE:
 *   Esta operación solo revierte el efecto contable/stock INTERNO del sistema.
 *   NO genera una Nota de Crédito electrónica real ni notifica a SUNAT/OSE.
 *   La emisión del comprobante fiscal de anulación se implementará en la Fase 5
 *   (Facturación) cuando se integre el PSE/OSE correspondiente.
 *
 * @param {number|string} id
 * @param {string}        void_reason  Motivo obligatorio de anulación
 */
export async function voidSale(id, void_reason) {
  if (!void_reason || String(void_reason).trim() === '') {
    throw new AppError('"void_reason" es obligatorio para anular una venta.', 'MISSING_FIELD', 422);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que la venta existe y no está ya anulada
    const { rows: saleRows } = await client.query(
      `SELECT * FROM sales WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!saleRows[0]) {
      throw new AppError(`Venta con id ${id} no encontrada.`, 'SALE_NOT_FOUND', 404);
    }
    if (saleRows[0].status === 'voided') {
      throw new AppError(`La venta #${id} ya estaba anulada.`, 'ALREADY_VOIDED', 422);
    }

    // Obtener ítems con su tipo (producto directo o kit)
    const { rows: saleItems } = await client.query(
      `SELECT si.product_id, si.kit_id, si.quantity FROM sale_items AS si WHERE si.sale_id = $1`,
      [id]
    );

    // Restaurar stock
    for (const item of saleItems) {
      if (item.product_id != null) {
        // Producto directo: restaurar qty
        await restoreStock(client, item.product_id, item.quantity);
      } else if (item.kit_id != null) {
        // Kit: restaurar cada componente en la cantidad correspondiente
        const { rows: components } = await client.query(
          `SELECT product_id, quantity FROM kit_items WHERE kit_id = $1`,
          [item.kit_id]
        );
        for (const comp of components) {
          await restoreStock(client, comp.product_id, comp.quantity * item.quantity);
        }
      }
    }

    // Marcar la venta como anulada
    const { rows: updated } = await client.query(
      `UPDATE sales
       SET status = 'voided', void_reason = $1, voided_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [void_reason.trim(), id]
    );

    await client.query('COMMIT');
    return updated[0];

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
