import bcrypt from 'bcrypt';
import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';
import { validatePasswordPolicy } from '../../shared/utils/passwordPolicy.js';
import { logAudit, diffObjects } from '../../shared/audit.js';

const SALT_ROUNDS = 10;
const VALID_ROLES = ['admin', 'cajero', 'almacenero', 'mecanico'];

/**
 * Crea un nuevo usuario para la empresa.
 * Exclusivo para rol 'admin'. Valida política de contraseñas y unicidad de email.
 * Todo usuario nuevo se inicializa con must_change_password = true.
 *
 * @param {{ name, email, password, role }} data
 * @param {number} companyId
 * @param {number|null} [currentUserId]
 */
export async function create({ name, email, password, role }, companyId, currentUserId = null) {
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO users (company_id, name, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, name, email, role, is_active, must_change_password, last_login_at, created_at`,
      [companyId, name.trim(), email.trim().toLowerCase(), password_hash, role]
    );
    const newUser = rows[0];

    await logAudit(client, {
      companyId,
      userId: currentUserId,
      entity: 'user',
      entityId: newUser.id,
      action: 'create',
      changes: {
        name: { new: newUser.name },
        email: { new: newUser.email },
        role: { new: newUser.role },
      },
    });

    await client.query('COMMIT');
    return newUser;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      // Violación de restricción UNIQUE en email
      throw new AppError(`El correo electrónico "${email}" ya está registrado en el sistema.`, 'EMAIL_ALREADY_EXISTS', 409);
    }
    throw err;
  } finally {
    client.release();
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar existencia previa del usuario objetivo con bloqueo
    const { rows: targetRows } = await client.query(
      `SELECT * FROM users WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    const targetUser = targetRows[0];
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
      const { rows: countRows } = await client.query(
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

    const diff = diffObjects(
      targetUser,
      {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(is_active !== undefined ? { is_active } : {}),
      },
      ['name', 'role', 'is_active']
    );

    const { rows } = await client.query(
      `UPDATE users
       SET
         name       = COALESCE($1, name),
         role       = COALESCE($2, role),
         is_active  = COALESCE($3, is_active),
         updated_at = NOW()
       WHERE id = $4 AND company_id = $5
       RETURNING id, name, email, role, is_active, must_change_password, last_login_at, updated_at`,
      [name ? name.trim() : null, role ?? null, is_active ?? null, id, companyId]
    );
    const updatedUser = rows[0];

    if (diff && Object.keys(diff).length > 0) {
      let action = 'update';
      if (diff.is_active && diff.is_active.new === true && diff.is_active.old === false) {
        action = 'reactivate';
      } else if (diff.role) {
        action = 'role_change';
      }

      await logAudit(client, {
        companyId,
        userId: currentUserId,
        entity: 'user',
        entityId: Number(id),
        action,
        changes: diff,
      });
    }

    await client.query('COMMIT');
    return updatedUser;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: targetRows } = await client.query(
      `SELECT * FROM users WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    const targetUser = targetRows[0];
    if (!targetUser || !targetUser.is_active) {
      await client.query('ROLLBACK');
      return false;
    }

    const isSelf = Number(id) === Number(currentUserId);
    if (isSelf) {
      throw new AppError('No puedes desactivar tu propia cuenta de administrador.', 'SELF_DEACTIVATION_PROHIBITED', 409);
    }

    if (targetUser.role === 'admin') {
      const { rows: countRows } = await client.query(
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

    const { rowCount } = await client.query(
      `UPDATE users SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [id, companyId]
    );

    await logAudit(client, {
      companyId,
      userId: currentUserId,
      entity: 'user',
      entityId: Number(id),
      action: 'deactivate',
      changes: { is_active: { old: true, new: false } },
    });

    await client.query('COMMIT');
    return rowCount > 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
 * @param {number|string|null} [currentUserId]
 */
export async function resetPassword(id, { new_password }, companyId, currentUserId = null) {
  if (!new_password) {
    throw new AppError('El campo "new_password" es obligatorio.', 'MISSING_FIELD', 422);
  }

  const policy = validatePasswordPolicy(new_password);
  if (!policy.valid) {
    throw new AppError(policy.message, 'INVALID_PASSWORD', 422);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: targetRows } = await client.query(
      `SELECT * FROM users WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    const targetUser = targetRows[0];
    if (!targetUser) {
      throw new AppError(`Usuario #${id} no encontrado.`, 'USER_NOT_FOUND', 404);
    }

    const password_hash = await bcrypt.hash(new_password, SALT_ROUNDS);

    const { rows } = await client.query(
      `UPDATE users
       SET password_hash = $1, must_change_password = true, updated_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING id, name, email, role, is_active, must_change_password, updated_at`,
      [password_hash, id, companyId]
    );

    // Loguear sin contraseña ni hash
    await logAudit(client, {
      companyId,
      userId: currentUserId,
      entity: 'user',
      entityId: Number(id),
      action: 'password_reset',
      changes: { password_reset: true },
    });

    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
