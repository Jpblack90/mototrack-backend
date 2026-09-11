import bcrypt from 'bcrypt';
import pool from '../../config/database.js';

const SALT_ROUNDS = 10;
const VALID_ROLES  = ['admin', 'cajero', 'mecanico'];

class AppError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Crea un nuevo usuario. Solo el Administrador puede llamar a este servicio.
 * Hashea el password con bcrypt antes de insertar.
 */
export async function create({ name, email, password, role }) {
  if (!name || !email || !password || !role) {
    throw new AppError('name, email, password y role son obligatorios.', 'MISSING_FIELD', 422);
  }
  if (!VALID_ROLES.includes(role)) {
    throw new AppError(
      `"role" debe ser uno de: ${VALID_ROLES.join(', ')}.`,
      'INVALID_FIELD',
      422
    );
  }

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, is_active, created_at`,
      [name.trim(), email.trim().toLowerCase(), password_hash, role]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      // Unique violation en email
      throw new AppError(`El email "${email}" ya está registrado.`, 'EMAIL_ALREADY_EXISTS', 422);
    }
    throw err;
  }
}

/**
 * Lista todos los usuarios sin exponer password_hash.
 */
export async function getAll() {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, is_active, created_at, updated_at
     FROM   users
     ORDER  BY id ASC`
  );
  return rows;
}

/**
 * Retorna un usuario por id sin exponer password_hash.
 */
export async function getById(id) {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, is_active, created_at, updated_at
     FROM   users WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Actualiza name, role y/o is_active con COALESCE.
 * No permite cambiar email ni password aquí.
 */
export async function update(id, { name, role, is_active }) {
  if (role && !VALID_ROLES.includes(role)) {
    throw new AppError(
      `"role" debe ser uno de: ${VALID_ROLES.join(', ')}.`,
      'INVALID_FIELD',
      422
    );
  }

  const { rows } = await pool.query(
    `UPDATE users
     SET
       name       = COALESCE($1, name),
       role       = COALESCE($2, role),
       is_active  = COALESCE($3, is_active),
       updated_at = NOW()
     WHERE id = $4
     RETURNING id, name, email, role, is_active, updated_at`,
    [name ?? null, role ?? null, is_active ?? null, id]
  );

  if (!rows[0]) throw new AppError(`Usuario #${id} no encontrado.`, 'USER_NOT_FOUND', 404);
  return rows[0];
}

/**
 * Soft-delete: is_active = false.
 */
export async function remove(id) {
  const { rowCount } = await pool.query(
    `UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active = true`,
    [id]
  );
  return rowCount > 0;
}
