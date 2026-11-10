import pool from '../../config/database.js';
import { logAudit, diffObjects } from '../../shared/audit.js';
import { normalizeModel } from '../../shared/utils/modelNormalizer.js';
import { testHooksEnabled } from '../../shared/utils/testHooks.js';

export { normalizeModel };

// ─── Categorías oficiales de productos ────────────────────────────────────────

export const PRODUCT_CATEGORIES = [
  'Motor',
  'Filtros',
  'Frenos',
  'Transmisión',
  'Suspensión',
  'Sistema eléctrico',
  'Iluminación',
  'Llantas y cámaras',
  'Lubricantes',
  'Carrocería',
  'Accesorios',
  'Otros',
];

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
 * Valida los campos obligatorios y la regla de margen.
 * @param {object} data  Cuerpo de la petición
 * @throws {AppError}   Si falta un campo o el margen es negativo sin force
 */
function validateProductData(data) {
  const { name, cost_price, sale_price, force } = data;

  // (a) Campos obligatorios
  if (!name || name.trim() === '') {
    throw new AppError('El campo "name" es obligatorio.', 'MISSING_FIELD', 400);
  }
  if (cost_price === undefined || cost_price === null || cost_price === '') {
    throw new AppError('El campo "cost_price" es obligatorio.', 'MISSING_FIELD', 400);
  }
  if (sale_price === undefined || sale_price === null || sale_price === '') {
    throw new AppError('El campo "sale_price" es obligatorio.', 'MISSING_FIELD', 400);
  }

  const cp = Number(cost_price);
  const sp = Number(sale_price);

  if (isNaN(cp) || isNaN(sp)) {
    throw new AppError(
      '"cost_price" y "sale_price" deben ser valores numéricos.',
      'INVALID_FIELD',
      400
    );
  }

  // (b) Regla de margen — se omite si el Administrador envía force: true
  if (sp <= cp && !force) {
    throw new AppError(
      `El precio de venta (${sp}) debe ser mayor al costo (${cp}). ` +
      'Si deseas forzar esta operación, envía "force": true en el body.',
      'NEGATIVE_MARGIN',
      422
    );
  }

  // (c) Validación de categoría
  if (data.category !== undefined && data.category !== null && data.category !== '') {
    if (!PRODUCT_CATEGORIES.includes(data.category)) {
      throw new AppError(
        `"category" inválida. Debe ser una de: ${PRODUCT_CATEGORIES.join(', ')}.`,
        'INVALID_FIELD',
        422
      );
    }
  }

  // (d) Validación de compatible_models (array de strings, máximo 20)
  if (data.compatible_models !== undefined && data.compatible_models !== null) {
    if (!Array.isArray(data.compatible_models)) {
      throw new AppError('"compatible_models" debe ser un array de strings.', 'INVALID_FIELD', 422);
    }
    const cleaned = [...new Set(data.compatible_models.map(m => String(m).trim()).filter(Boolean))];
    if (cleaned.length > 20) {
      throw new AppError('"compatible_models" no puede superar 20 modelos.', 'INVALID_FIELD', 422);
    }
  }
}

/**
 * Sanitiza la lista de modelos compatibles: trim, deduplicación y máximo 20.
 * @param {string[]|null|undefined} models
 * @returns {string[]}
 */
function sanitizeCompatibleModels(models) {
  if (!models || !Array.isArray(models)) return [];
  const cleaned = [...new Set(models.map(m => String(m).trim()).filter(Boolean))];
  return cleaned.slice(0, 20);
}

/**
 * Calcula el margen bruto.
 * @param {number|string} sale_price
 * @param {number|string} cost_price
 * @returns {string} margen redondeado a 2 decimales
 */
function calcMargin(sale_price, cost_price) {
  return (Number(sale_price) - Number(cost_price)).toFixed(2);
}

// ─── Servicios ────────────────────────────────────────────────────────────────

/**
 * Retorna todos los productos activos.
 * Filtra por `search` (name, sku, brand, category, compatible_models),
 * `compatible_with` (búsqueda normalizada en compatible_models) y
 * `stock_status` ('low': 0 < stock <= min_stock; 'out': stock = 0).
 *
 * @param {{ search?: string, compatible_with?: string, stock_status?: string }} options
 * @param {number} companyId
 */
export async function getAll({ search, compatible_with, stock_status } = {}, companyId) {
  const conditions = ['is_active = true', 'company_id = $1'];
  const params = [companyId];
  let paramIdx = 2;

  if (search && search.trim() !== '') {
    const pattern = `%${search.trim()}%`;
    conditions.push(`(
      name ILIKE $${paramIdx}
      OR sku ILIKE $${paramIdx}
      OR brand ILIKE $${paramIdx}
      OR category ILIKE $${paramIdx}
      OR array_to_string(compatible_models, ' ') ILIKE $${paramIdx}
    )`);
    params.push(pattern);
    paramIdx++;
  }

  if (compatible_with && compatible_with.trim() !== '') {
    conditions.push(`EXISTS (
      SELECT 1 FROM unnest(compatible_models) AS m
      WHERE regexp_replace(lower(unaccent(m)), '[^a-z0-9]', '', 'g') = regexp_replace(lower(unaccent($${paramIdx})), '[^a-z0-9]', '', 'g')
    )`);
    params.push(compatible_with.trim());
    paramIdx++;
  }

  if (stock_status === 'low') {
    conditions.push('stock > 0 AND stock <= min_stock');
  } else if (stock_status === 'out') {
    conditions.push('stock = 0');
  }

  const query = `
    SELECT *
    FROM   products
    WHERE  ${conditions.join(' AND ')}
    ORDER  BY id ASC
  `;

  const { rows } = await pool.query(query, params);

  // Añade el margen calculado a cada fila en la respuesta
  return rows.map((p) => ({ ...p, margin: calcMargin(p.sale_price, p.cost_price) }));
}

/**
 * Retorna las alertas de stock agrupadas en out_of_stock y low_stock para la empresa.
 * Ordenadas por urgencia (agotados por min_stock DESC; stock bajo por stock ASC, min_stock DESC).
 *
 * @param {number} companyId
 */
export async function getAlerts(companyId) {
  const outQuery = `
    SELECT id, name, sku, stock, min_stock, category
    FROM   products
    WHERE  company_id = $1 AND is_active = true AND stock = 0
    ORDER  BY min_stock DESC, name ASC
  `;
  const lowQuery = `
    SELECT id, name, sku, stock, min_stock, category
    FROM   products
    WHERE  company_id = $1 AND is_active = true AND stock > 0 AND stock <= min_stock
    ORDER  BY stock ASC, min_stock DESC, name ASC
  `;

  const [outRes, lowRes] = await Promise.all([
    pool.query(outQuery, [companyId]),
    pool.query(lowQuery, [companyId]),
  ]);

  const outOfStock = outRes.rows;
  const lowStock = lowRes.rows;
  const total = outOfStock.length + lowStock.length;

  return {
    out_of_stock: outOfStock,
    low_stock: lowStock,
    total_alerts: total,
    total,
  };
}

/**
 * Retorna hasta 5 repuestos activos con stock > 0 alternativos al producto indicado.
 * Misma categoría y priorizados por modelos compatibles compartidos (o con la moto del cliente).
 * Si el producto original no tiene categoría:
 *   - Si tiene modelos compatibles, busca por modelos compartidos.
 *   - Si tampoco tiene modelos compatibles, devuelve lista vacía [].
 *
 * @param {number|string} id
 * @param {number}        companyId
 * @param {{ compatible_with?: string }} options
 */
export async function getAlternatives(id, companyId, { compatible_with } = {}) {
  const orig = await getById(id, companyId);
  if (!orig) return null;

  const origCategory = orig.category;
  const origModels = (orig.compatible_models || [])
    .map(normalizeModel)
    .filter(Boolean);
  const clientModel = compatible_with ? normalizeModel(compatible_with) : null;

  // Si no tiene categoría ni modelos compatibles -> lista vacía
  if (!origCategory && origModels.length === 0) {
    return [];
  }

  let query;
  let params;

  if (origCategory) {
    query = `
      SELECT id, name, sku, brand, category, sale_price, cost_price, stock, min_stock, compatible_models
      FROM   products
      WHERE  company_id = $1 AND id != $2 AND is_active = true AND stock > 0 AND category = $3
    `;
    params = [companyId, id, origCategory];
  } else {
    // Sin categoría pero con modelos compatibles: busca por modelos compartidos
    query = `
      SELECT id, name, sku, brand, category, sale_price, cost_price, stock, min_stock, compatible_models
      FROM   products
      WHERE  company_id = $1 AND id != $2 AND is_active = true AND stock > 0
    `;
    params = [companyId, id];
  }

  const { rows: candidates } = await pool.query(query, params);

  const scored = [];
  for (const cand of candidates) {
    const candModels = (cand.compatible_models || []).map(normalizeModel).filter(Boolean);
    const matchesClient = clientModel ? candModels.includes(clientModel) : false;
    const sharedCount = origModels.length > 0
      ? candModels.filter((m) => origModels.includes(m)).length
      : 0;

    // Si el original no tenía categoría, solo incluir si comparte al menos un modelo o coincide con la moto del cliente
    if (!origCategory && sharedCount === 0 && !matchesClient) {
      continue;
    }

    const item = {
      id: cand.id,
      name: cand.name,
      sku: cand.sku,
      brand: cand.brand,
      category: cand.category,
      sale_price: cand.sale_price,
      stock: cand.stock,
      min_stock: cand.min_stock,
      compatible_models: cand.compatible_models,
      margin: calcMargin(cand.sale_price, cand.cost_price),
      matches_client: matchesClient,
      shared_models_count: sharedCount,
    };

    if (compatible_with) {
      item.is_compatible = Boolean(matchesClient);
    }

    scored.push(item);
  }

  scored.sort((a, b) => {
    if (clientModel) {
      if (a.matches_client !== b.matches_client) {
        return a.matches_client ? -1 : 1;
      }
    }
    if (b.shared_models_count !== a.shared_models_count) {
      return b.shared_models_count - a.shared_models_count;
    }
    if (b.stock !== a.stock) {
      return b.stock - a.stock;
    }
    return a.name.localeCompare(b.name);
  });

  return scored.slice(0, 5);
}

/**
 * Retorna un único producto activo por id y empresa.
 * @param {number|string} id
 * @param {number}        companyId
 * @returns {object|null}
 */
export async function getById(id, companyId) {
  const { rows } = await pool.query(
    `SELECT * FROM products WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [id, companyId]
  );
  if (!rows[0]) return null;
  const p = rows[0];
  return { ...p, margin: calcMargin(p.sale_price, p.cost_price) };
}

/**
 * Crea un nuevo producto.
 * Valida campos y regla de margen (con soporte para force).
 *
 * @param {object}      data
 * @param {number}      companyId ID de la empresa del usuario
 * @param {number|null} userId    ID del usuario autenticado (req.user.id)
 * @throws {AppError}
 */
export async function create(data, companyId, userId = null) {
  validateProductData(data); // lanza si hay error

  const {
    sku,
    name,
    brand,
    category,
    compatible_models,
    cost_price,
    sale_price,
    stock = 0,
    min_stock = 5,
    ai_confidence,
    registration_method = 'manual',
    force,
  } = data;

  // force_approved_by solo se guarda si el admin usó force:true
  const forceApprovedBy = force === true ? (userId ?? null) : null;
  const sanitizedModels = sanitizeCompatibleModels(compatible_models);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO products
         (company_id, sku, name, brand, category, compatible_models, cost_price, sale_price,
          stock, min_stock, ai_confidence, registration_method, force_approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        companyId,
        sku ?? null,
        name.trim(),
        brand ?? null,
        category || null,
        sanitizedModels,
        Number(cost_price),
        Number(sale_price),
        Number(stock),
        Number(min_stock),
        ai_confidence != null ? Number(ai_confidence) : null,
        registration_method,
        forceApprovedBy,
      ]
    );

    const p = rows[0];

    // Log de auditoría: creación de producto
    await logAudit(client, {
      companyId,
      userId,
      entity: 'product',
      entityId: p.id,
      action: 'create',
      changes: {
        name: { new: p.name },
        cost_price: { new: Number(p.cost_price) },
        sale_price: { new: Number(p.sale_price) },
        stock: { new: Number(p.stock) },
        min_stock: { new: Number(p.min_stock) },
        category: { new: p.category },
        compatible_models: { new: p.compatible_models || [] },
      },
    });

    // Log de auditoría adicional si se forzó margen negativo
    if (force === true) {
      await logAudit(client, {
        companyId,
        userId,
        entity: 'product',
        entityId: p.id,
        action: 'forced_negative_margin',
        changes: {
          cost_price: Number(p.cost_price),
          sale_price: Number(p.sale_price),
          margin: calcMargin(p.sale_price, p.cost_price),
          approved_by: userId,
        },
      });
    }

    await client.query('COMMIT');
    return { ...p, margin: calcMargin(p.sale_price, p.cost_price) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Actualiza un producto activo por id y empresa.
 * Aplica la misma validación de margen que create().
 *
 * @param {number|string} id
 * @param {object}        data
 * @param {number}        companyId
 * @param {number|null}   userId  ID del usuario autenticado (req.user.id)
 * @returns {object|null} null si no existe o está inactivo
 */
export async function update(id, data, companyId, userId = null, options = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que el producto existe y pertenece a la empresa (bloqueando fila para update)
    const { rows: existingRows } = await client.query(
      `SELECT * FROM products WHERE id = $1 AND company_id = $2 AND is_active = true FOR UPDATE`,
      [id, companyId]
    );
    if (!existingRows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const existing = existingRows[0];

    // Si el caller no envió algún precio, usamos el valor actual de la BD
    const merged = {
      name: data.name ?? existing.name,
      cost_price: data.cost_price ?? existing.cost_price,
      sale_price: data.sale_price ?? existing.sale_price,
      force: data.force,
      category: data.category !== undefined ? data.category : existing.category,
      compatible_models: data.compatible_models !== undefined ? data.compatible_models : existing.compatible_models,
    };

    validateProductData(merged);

    const {
      sku,
      name,
      brand,
      category,
      compatible_models,
      cost_price,
      sale_price,
      stock,
      min_stock,
      ai_confidence,
      registration_method,
      force,
    } = data;

    // force_approved_by solo se actualiza si el admin usó force:true
    const forceApprovedBy = force === true ? (userId ?? null) : null;

    const hasCategory = category !== undefined;
    const categoryVal = (hasCategory && category && typeof category === 'string' && category.trim() !== '')
      ? category.trim()
      : null;

    const hasCompatibleModels = compatible_models !== undefined;
    const modelsVal = hasCompatibleModels && Array.isArray(compatible_models)
      ? sanitizeCompatibleModels(compatible_models)
      : [];

    const { rows } = await client.query(
      `UPDATE products
       SET
         sku                 = COALESCE($1,  sku),
         name                = COALESCE($2,  name),
         brand               = COALESCE($3,  brand),
         category            = CASE WHEN $4::boolean THEN $5::varchar ELSE category END,
         compatible_models   = CASE WHEN $6::boolean THEN $7::text[]  ELSE compatible_models END,
         cost_price          = COALESCE($8,  cost_price),
         sale_price          = COALESCE($9,  sale_price),
         stock               = COALESCE($10, stock),
         min_stock           = COALESCE($11, min_stock),
         ai_confidence       = COALESCE($12, ai_confidence),
         registration_method = COALESCE($13, registration_method),
         force_approved_by   = COALESCE($14, force_approved_by),
         updated_at          = NOW()
       WHERE id = $15 AND company_id = $16 AND is_active = true
       RETURNING *`,
      [
        sku ?? null,
        name ? name.trim() : null,
        brand ?? null,
        hasCategory,
        categoryVal,
        hasCompatibleModels,
        modelsVal,
        cost_price != null ? Number(cost_price) : null,
        sale_price != null ? Number(sale_price) : null,
        stock != null ? Number(stock) : null,
        min_stock != null ? Number(min_stock) : null,
        ai_confidence != null ? Number(ai_confidence) : null,
        registration_method ?? null,
        forceApprovedBy,
        id,
        companyId,
      ]
    );

    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const p = rows[0];

    // Calcular diff para auditoría
    const newValuesForDiff = {
      name: name !== undefined ? name.trim() : undefined,
      cost_price: cost_price != null ? Number(cost_price) : undefined,
      sale_price: sale_price != null ? Number(sale_price) : undefined,
      stock: stock != null ? Number(stock) : undefined,
      min_stock: min_stock != null ? Number(min_stock) : undefined,
      category: hasCategory ? categoryVal : undefined,
      compatible_models: hasCompatibleModels ? modelsVal : undefined,
    };

    const diff = diffObjects(existing, newValuesForDiff, [
      'name',
      'cost_price',
      'sale_price',
      'stock',
      'min_stock',
      'category',
      'compatible_models',
    ]);

    if (diff) {
      await logAudit(client, {
        companyId,
        userId,
        entity: 'product',
        entityId: Number(id),
        action: 'update',
        changes: diff,
      });
    }

    if (force === true) {
      await logAudit(client, {
        companyId,
        userId,
        entity: 'product',
        entityId: Number(id),
        action: 'forced_negative_margin',
        changes: {
          cost_price: Number(p.cost_price),
          sale_price: Number(p.sale_price),
          margin: calcMargin(p.sale_price, p.cost_price),
          approved_by: userId,
        },
      });
    }

    // Punto de prueba de rollback (solo si test hooks están habilitados)
    if (
      testHooksEnabled() &&
      (process.env.FORCE_AUDIT_FAIL === '1' || options?.forceFail === true)
    ) {
      throw new Error('[TEST] Error forzado después de insertar el log de auditoría y antes del COMMIT');
    }

    await client.query('COMMIT');
    return { ...p, margin: calcMargin(p.sale_price, p.cost_price) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Soft-delete: marca el producto como inactivo filtrando por empresa.
 * NUNCA elimina el registro de la base de datos.
 *
 * @param {number|string} id
 * @param {number}        companyId
 * @param {number|null}   userId
 * @returns {boolean} false si el producto no existe o ya estaba inactivo
 */
export async function remove(id, companyId, userId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, name, is_active FROM products
       WHERE id = $1 AND company_id = $2 AND is_active = true
       FOR UPDATE`,
      [id, companyId]
    );

    if (!rows[0]) {
      await client.query('ROLLBACK');
      return false;
    }

    const { rowCount } = await client.query(
      `UPDATE products SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [id, companyId]
    );

    if (rowCount > 0) {
      await logAudit(client, {
        companyId,
        userId,
        entity: 'product',
        entityId: Number(id),
        action: 'deactivate',
        changes: { is_active: { old: true, new: false } },
      });
    }

    await client.query('COMMIT');
    return rowCount > 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// =============================================================================
// Funciones de stock transaccional — SOLO para uso desde sales.service.js
// Ambas reciben un "client" ya conectado y dentro de un BEGIN.
// NUNCA pasan el pool directamente: deben participar de la transacción del caller.
// =============================================================================

/**
 * Decrementa el stock de un producto dentro de una transacción abierta.
 * Usa SELECT ... FOR UPDATE para evitar condiciones de carrera y valida pertenencia a la empresa.
 *
 * @param {import('pg').PoolClient} client  Cliente de pg ya en transacción
 * @param {number}                  productId
 * @param {number}                  quantity  Unidades a descontar
 * @param {number}                  companyId
 * @throws {AppError} INSUFFICIENT_STOCK si el stock disponible es menor a quantity
 */
export async function decrementStock(client, productId, quantity, companyId) {
  // Bloquea la fila para evitar que otra transacción concurrente lea el mismo stock
  const { rows } = await client.query(
    `SELECT id, name, sku, stock, min_stock FROM products WHERE id = $1 AND company_id = $2 AND is_active = true FOR UPDATE`,
    [productId, companyId]
  );

  if (!rows[0]) {
    throw new AppError(
      `Producto con id ${productId} no encontrado o inactivo.`,
      'PRODUCT_NOT_FOUND',
      404
    );
  }

  const { id, name, sku, stock, min_stock } = rows[0];

  if (stock < quantity) {
    throw new AppError(
      `Stock insuficiente para "${name}" (id ${productId}). ` +
        `Disponible: ${stock}, solicitado: ${quantity}.`,
      'INSUFFICIENT_STOCK',
      422
    );
  }

  const newStock = stock - quantity;

  await client.query(
    `UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
    [newStock, productId, companyId]
  );

  return {
    id,
    name,
    sku,
    stock_before: stock,
    stock_after: newStock,
    min_stock,
  };
}

/**
 * Restaura el stock de un producto dentro de una transacción abierta.
 * Usado al anular una venta.
 *
 * @param {import('pg').PoolClient} client  Cliente de pg ya en transacción
 * @param {number}                  productId
 * @param {number}                  quantity  Unidades a devolver
 * @param {number}                  companyId
 */
export async function restoreStock(client, productId, quantity, companyId) {
  await client.query(
    `UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
    [quantity, productId, companyId]
  );
}

/**
 * POST /api/inventory/:id/stock-entry (Tarea 14.2a)
 * Registra una entrada de mercadería para un producto existente.
 * Transaccional: SELECT ... FOR UPDATE, UPDATE stock = stock + quantity, logAudit.
 *
 * @param {number|string} productId
 * @param {{ quantity: number, note?: string }} data
 * @param {number} companyId
 * @param {number} userId
 * @returns {Promise<object>}
 */
export async function recordStockEntry(productId, { quantity, note } = {}, companyId, userId) {
  // 1. Validaciones
  if (
    quantity === undefined ||
    quantity === null ||
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 10000
  ) {
    throw new AppError(
      'La cantidad debe ser un número entero entre 1 y 10000.',
      'INVALID_QUANTITY',
      422
    );
  }

  if (note !== undefined && note !== null) {
    if (typeof note !== 'string' || note.length > 200) {
      throw new AppError(
        'La nota no puede exceder los 200 caracteres.',
        'INVALID_NOTE',
        422
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 2. SELECT ... FOR UPDATE del producto (company_id + is_active)
    const { rows } = await client.query(
      `SELECT * FROM products WHERE id = $1 AND company_id = $2 AND is_active = true FOR UPDATE`,
      [productId, companyId]
    );

    if (!rows[0]) {
      throw new AppError(
        `Producto #${productId} no encontrado o inactivo.`,
        'PRODUCT_NOT_FOUND',
        404
      );
    }

    const current = rows[0];
    const previousStock = Number(current.stock);
    const newStock = previousStock + quantity;

    // 3. UPDATE stock = stock + quantity
    const { rows: updatedRows } = await client.query(
      `UPDATE products
       SET stock = $1, updated_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [newStock, productId, companyId]
    );

    const updated = updatedRows[0];

    // 4. logAudit
    await logAudit(client, {
      companyId,
      userId,
      entity: 'product',
      entityId: Number(productId),
      action: 'stock_entry',
      changes: {
        stock: { old: previousStock, new: newStock },
        quantity,
        note: note ? note.trim() : null,
      },
    });

    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

