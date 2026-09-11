import pool from '../../config/database.js';

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
export async function getAll({ search } = {}) {
  let query;
  let params;

  if (search && search.trim() !== '') {
    const pattern = `%${search.trim()}%`;
    query = `
      SELECT *
      FROM   products
      WHERE  is_active = true
        AND  (name ILIKE $1 OR sku ILIKE $1)
      ORDER  BY id ASC
    `;
    params = [pattern];
  } else {
    query = `
      SELECT *
      FROM   products
      WHERE  is_active = true
      ORDER  BY id ASC
    `;
    params = [];
  }

  const { rows } = await pool.query(query, params);

  // Añade el margen calculado a cada fila en la respuesta
  return rows.map((p) => ({ ...p, margin: calcMargin(p.sale_price, p.cost_price) }));
}

/**
 * Retorna un único producto activo por id.
 * @param {number|string} id
 * @returns {object|null}
 */
export async function getById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM products WHERE id = $1 AND is_active = true`,
    [id]
  );
  if (!rows[0]) return null;
  const p = rows[0];
  return { ...p, margin: calcMargin(p.sale_price, p.cost_price) };
}

/**
 * Crea un nuevo producto.
 * Valida campos y regla de margen (con soporte para force).
 *
 * @param {object} data
 * @throws {AppError}
 */
export async function create(data) {
  validateProductData(data); // lanza si hay error

  const {
    sku,
    name,
    brand,
    compatible_models,
    cost_price,
    sale_price,
    stock = 0,
    min_stock = 5,
    ai_confidence,
    registration_method = 'manual',
  } = data;

  const { rows } = await pool.query(
    `INSERT INTO products
       (sku, name, brand, compatible_models, cost_price, sale_price,
        stock, min_stock, ai_confidence, registration_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      sku ?? null,
      name.trim(),
      brand ?? null,
      compatible_models ?? null,
      Number(cost_price),
      Number(sale_price),
      Number(stock),
      Number(min_stock),
      ai_confidence != null ? Number(ai_confidence) : null,
      registration_method,
    ]
  );

  const p = rows[0];
  return { ...p, margin: calcMargin(p.sale_price, p.cost_price) };
}

/**
 * Actualiza un producto activo por id.
 * Aplica la misma validación de margen que create().
 *
 * @param {number|string} id
 * @param {object}        data
 * @returns {object|null}  null si no existe o está inactivo
 */
export async function update(id, data) {
  // Verificar que el producto existe y está activo
  const existing = await getById(id);
  if (!existing) return null;

  // Si el caller no envió algún precio, usamos el valor actual de la BD
  const merged = {
    name: data.name ?? existing.name,
    cost_price: data.cost_price ?? existing.cost_price,
    sale_price: data.sale_price ?? existing.sale_price,
    force: data.force,
  };

  validateProductData(merged);

  const {
    sku,
    name,
    brand,
    compatible_models,
    cost_price,
    sale_price,
    stock,
    min_stock,
    ai_confidence,
    registration_method,
  } = data;

  const { rows } = await pool.query(
    `UPDATE products
     SET
       sku                 = COALESCE($1,  sku),
       name                = COALESCE($2,  name),
       brand               = COALESCE($3,  brand),
       compatible_models   = COALESCE($4,  compatible_models),
       cost_price          = COALESCE($5,  cost_price),
       sale_price          = COALESCE($6,  sale_price),
       stock               = COALESCE($7,  stock),
       min_stock           = COALESCE($8,  min_stock),
       ai_confidence       = COALESCE($9,  ai_confidence),
       registration_method = COALESCE($10, registration_method),
       updated_at          = NOW()
     WHERE id = $11 AND is_active = true
     RETURNING *`,
    [
      sku ?? null,
      name ? name.trim() : null,
      brand ?? null,
      compatible_models ?? null,
      cost_price != null ? Number(cost_price) : null,
      sale_price != null ? Number(sale_price) : null,
      stock != null ? Number(stock) : null,
      min_stock != null ? Number(min_stock) : null,
      ai_confidence != null ? Number(ai_confidence) : null,
      registration_method ?? null,
      id,
    ]
  );

  if (!rows[0]) return null;
  const p = rows[0];
  return { ...p, margin: calcMargin(p.sale_price, p.cost_price) };
}

/**
 * Soft-delete: marca el producto como inactivo.
 * NUNCA elimina el registro de la base de datos.
 *
 * @param {number|string} id
 * @returns {boolean} false si el producto no existe o ya estaba inactivo
 */
export async function remove(id) {
  const { rowCount } = await pool.query(
    `UPDATE products SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND is_active = true`,
    [id]
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
 * Usa SELECT ... FOR UPDATE para evitar condiciones de carrera.
 *
 * @param {import('pg').PoolClient} client  Cliente de pg ya en transacción
 * @param {number}                  productId
 * @param {number}                  quantity  Unidades a descontar
 * @throws {AppError} INSUFFICIENT_STOCK si el stock disponible es menor a quantity
 */
export async function decrementStock(client, productId, quantity) {
  // Bloquea la fila para evitar que otra transacción concurrente lea el mismo stock
  const { rows } = await client.query(
    `SELECT id, name, stock FROM products WHERE id = $1 AND is_active = true FOR UPDATE`,
    [productId]
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
    `UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2`,
    [quantity, productId]
  );
}

/**
 * Restaura el stock de un producto dentro de una transacción abierta.
 * Usado al anular una venta.
 *
 * @param {import('pg').PoolClient} client  Cliente de pg ya en transacción
 * @param {number}                  productId
 * @param {number}                  quantity  Unidades a devolver
 */
export async function restoreStock(client, productId, quantity) {
  await client.query(
    `UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2`,
    [quantity, productId]
  );
}
