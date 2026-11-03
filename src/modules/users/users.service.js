import bcrypt from 'bcrypt';
import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';
import { validatePasswordPolicy } from '../../shared/utils/passwordPolicy.js';

const SALT_ROUNDS = 10;
const VALID_ROLES = ['admin', 'cajero', 'almacenero', 'mecanico'];

/**
 * Crea un nuevo usuario para la empresa.
 * Exclusivo para rol 'admin'. Valida política de contraseñas y unicidad de email.
 * Todo usuario nuevo se inicializa con must_change_password = true.
 *
 * @param {{ name, email, password, role }} data
 * @param {number} companyId
 */
export async function create({ name, email, password, role }, companyId) {
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

  const policy = validatePasswordPolicy(password);
  if (!policy.valid) {
    throw new AppError(policy.message, 'INVALID_PASSWORD', 422);
  }

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, name, email, role, is_active, must_change_password, last_login_at, created_at`,
      [companyId, name.trim(), email.trim().toLowerCase(), password_hash, role]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      // Violación de restricción UNIQUE en email
      throw new AppError(`El correo electrónico "${email}" ya está registrado en el sistema.`, 'EMAIL_ALREADY_EXISTS', 409);
    }
    throw err;
  }
}

/**
 * Lista todos los usuarios de la empresa sin exponer password_hash.
 * @param {number} companyId
 */
export async function getAll(companyId) {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, is_active, must_change_password, last_login_at, created_at, updated_at
     FROM   users
     WHERE  company_id = $1
     ORDER  BY id ASC`,
    [companyId]
  );
  return rows;
}

/**
 * Retorna un usuario por id y empresa sin exponer password_hash.
 * @param {number|string} id
 * @param {number} companyId
 */
export async function getById(id, companyId) {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, is_active, must_change_password, last_login_at, created_at, updated_at
     FROM   users
     WHERE  id = $1 AND company_id = $2`,
    [id, companyId]
  );
  return rows[0] ?? null;
}

/**
 * Actualiza name, role y/o is_active con protecciones de integridad:
 * 1. Un admin no puede desactivarse a sí mismo ni quitarse el rol de admin.
 * 2. No se puede desactivar ni cambiar de rol al último admin activo de la empresa.
 * 3. Permite reactivar usuarios con is_active = true.
 *
 * @param {number|string} id
 * @param {{ name?: string, role?: string, is_active?: boolean }} data
 * @param {number} companyId
 * @param {number|string} currentUserId
 */
export async function update(id, { name, role, is_active }, companyId, currentUserId) {
  if (role && !VALID_ROLES.includes(role)) {
    throw new AppError(
      `"role" debe ser uno de: ${VALID_ROLES.join(', ')}.`,
      'INVALID_FIELD',
      422
    );
  }

  // Verificar existencia previa del usuario objetivo
  const targetUser = await getById(id, companyId);
  if (!targetUser) {
    throw new AppError(`Usuario #${id} no encontrado.`, 'USER_NOT_FOUND', 404);
  }

  const isSelf = Number(id) === Number(currentUserId);

  // Regla 1: Un admin no puede desactivarse a sí mismo
  if (isSelf && is_active === false) {
    throw new AppError('No puedes desactivar tu propia cuenta de administrador.', 'SELF_DEACTIVATION_PROHIBITED', 409);
  }

  // Regla 2: Un admin no puede quitarse el rol de admin a sí mismo
  if (isSelf && role && role !== 'admin') {
    throw new AppError('No puedes quitarte el rol de administrador a ti mismo.', 'SELF_DEMOTION_PROHIBITED', 409);
  }

  // Regla 3: Protección del último admin activo de la empresa
  const isTargetActiveAdmin = targetUser.role === 'admin' && targetUser.is_active;
  const isDeactivating = is_active === false;
  const isDemoting = Boolean(role && role !== 'admin');

  if (isTargetActiveAdmin && (isDeactivating || isDemoting)) {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM users
       WHERE company_id = $1 AND role = 'admin' AND is_active = true`,
      [companyId]
    );
    const activeAdmins = countRows[0]?.count ?? 0;
    if (activeAdmins <= 1) {
      throw new AppError('No se puede desactivar o cambiar de rol al único administrador activo de la empresa.', 'LAST_ADMIN_PROTECTED', 409);
    }
  }

  const { rows } = await pool.query(
    `UPDATE users
     SET
       name       = COALESCE($1, name),
       role       = COALESCE($2, role),
       is_active  = COALESCE($3, is_active),
       updated_at = NOW()
     WHERE id = $4 AND company_id = $5
     RETURNING id, name, email, role, is_active, must_change_password, last_login_at, updated_at`,
    [name ?? null, role ?? null, is_active ?? null, id, companyId]
  );

  return rows[0];
}

/**
 * Baja lógica de usuario (is_active = false) con protecciones de integridad:
 * 1. Un admin no puede desactivarse a sí mismo.
 * 2. No se puede desactivar al último admin activo de la empresa.
 *
 * @param {number|string} id
 * @param {number} companyId
 * @param {number|string} currentUserId
 */
export async function remove(id, companyId, currentUserId) {
  const targetUser = await getById(id, companyId);
  if (!targetUser || !targetUser.is_active) {
    return false;
  }

  const isSelf = Number(id) === Number(currentUserId);
  if (isSelf) {
    throw new AppError('No puedes desactivar tu propia cuenta de administrador.', 'SELF_DEACTIVATION_PROHIBITED', 409);
  }

  if (targetUser.role === 'admin') {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM users
       WHERE company_id = $1 AND role = 'admin' AND is_active = true`,
      [companyId]
    );
    const activeAdmins = countRows[0]?.count ?? 0;
    if (activeAdmins <= 1) {
      throw new AppError('No se puede desactivar o cambiar de rol al único administrador activo de la empresa.', 'LAST_ADMIN_PROTECTED', 409);
    }
  }

  const { rowCount } = await pool.query(
    `UPDATE users SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [id, companyId]
  );
  return rowCount > 0;
}

/**
 * Restablece la contraseña de un usuario a una contraseña temporal.
 * Solo puede ser ejecutado por un administrador de la misma empresa.
 * Setea must_change_password = true.
 * Nunca retorna ni loguea la contraseña.
 *
 * @param {number|string} id
 * @param {{ new_password }} data
 * @param {number} companyId
 */
export async function resetPassword(id, { new_password }, companyId) {
  if (!new_password) {
    throw new AppError('El campo "new_password" es obligatorio.', 'MISSING_FIELD', 422);
  }

  const policy = validatePasswordPolicy(new_password);
  if (!policy.valid) {
    throw new AppError(policy.message, 'INVALID_PASSWORD', 422);
  }

  const targetUser = await getById(id, companyId);
  if (!targetUser) {
    throw new AppError(`Usuario #${id} no encontrado.`, 'USER_NOT_FOUND', 404);
  }

  const password_hash = await bcrypt.hash(new_password, SALT_ROUNDS);

  const { rows } = await pool.query(
    `UPDATE users
     SET password_hash = $1, must_change_password = true, updated_at = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING id, name, email, role, is_active, must_change_password, updated_at`,
    [password_hash, id, companyId]
  );

  return rows[0];
}
