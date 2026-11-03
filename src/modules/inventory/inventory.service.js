import pool from '../../config/database.js';

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
 * Si se pasa `search`, filtra por name o sku con ILIKE.
 *
 * @param {{ search?: string }} options
 */
export async function getAll({ search } = {}, companyId) {
  let query;
  let params;

  if (search && search.trim() !== '') {
    const pattern = `%${search.trim()}%`;
    query = `
      SELECT *
      FROM   products
      WHERE  is_active = true
        AND  company_id = $1
        AND  (
          name ILIKE $2
          OR sku ILIKE $2
          OR brand ILIKE $2
          OR category ILIKE $2
          OR array_to_string(compatible_models, ' ') ILIKE $2
        )
      ORDER  BY id ASC
    `;
    params = [companyId, pattern];
  } else {
    query = `
      SELECT *
      FROM   products
      WHERE  is_active = true
        AND  company_id = $1
      ORDER  BY id ASC
    `;
    params = [companyId];
  }

  const { rows } = await pool.query(query, params);

  // Añade el margen calculado a cada fila en la respuesta
  return rows.map((p) => ({ ...p, margin: calcMargin(p.sale_price, p.cost_price) }));
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

  const { rows } = await pool.query(
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
  return { ...p, margin: calcMargin(p.sale_price, p.cost_price) };
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
export async function update(id, data, companyId, userId = null) {
  // Verificar que el producto existe y pertenece a la empresa
  const existing = await getById(id, companyId);
  if (!existing) return null;

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

  const { rows } = await pool.query(
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

  if (!rows[0]) return null;
  const p = rows[0];
  return { ...p, margin: calcMargin(p.sale_price, p.cost_price) };
}

/**
 * Soft-delete: marca el producto como inactivo filtrando por empresa.
 * NUNCA elimina el registro de la base de datos.
 *
 * @param {number|string} id
 * @param {number}        companyId
 * @returns {boolean} false si el producto no existe o ya estaba inactivo
 */
export async function remove(id, companyId) {
  const { rowCount } = await pool.query(
    `UPDATE products SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [id, companyId]
  );
  return rowCount > 0;
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
    `SELECT id, name, stock FROM products WHERE id = $1 AND company_id = $2 AND is_active = true FOR UPDATE`,
    [productId, companyId]
  );

  if (!rows[0]) {
    throw new AppError(
      `Producto con id ${productId} no encontrado o inactivo.`,
      'PRODUCT_NOT_FOUND',
      404
    );
  }

  const { name, stock } = rows[0];

  if (stock < quantity) {
    throw new AppError(
      `Stock insuficiente para "${name}" (id ${productId}). ` +
        `Disponible: ${stock}, solicitado: ${quantity}.`,
      'INSUFFICIENT_STOCK',
      422
    );
  }

  await client.query(
    `UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
    [quantity, productId, companyId]
  );
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
