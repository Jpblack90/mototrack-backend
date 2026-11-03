import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';
import { validatePasswordPolicy } from '../../shared/utils/passwordPolicy.js';

const SALT_ROUNDS = 10;
const INVALID_CREDENTIALS_MSG = 'Email o contraseña incorrectos.';

/**
 * Login: verifica credenciales, actualiza last_login_at y emite un JWT de 8 horas.
 * @param {{ email, password }} param
 * @returns {{ token, user }}
 */
export async function login({ email, password }) {
  if (!email || !password) {
    throw new AppError(INVALID_CREDENTIALS_MSG, 'INVALID_CREDENTIALS', 401);
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.company_id, u.must_change_password,
            c.status AS company_status, c.is_active AS company_is_active
     FROM   users u
     JOIN   companies c ON c.id = u.company_id
     WHERE  u.email = $1 AND u.is_active = true`,
    [email.trim().toLowerCase()]
  );

  // Si el email no existe o está inactivo → mensaje genérico
  if (!rows[0]) {
    throw new AppError(INVALID_CREDENTIALS_MSG, 'INVALID_CREDENTIALS', 401);
  }

  const user = rows[0];
  const passwordMatch = await bcrypt.compare(password, user.password_hash);

  if (!passwordMatch) {
    throw new AppError(INVALID_CREDENTIALS_MSG, 'INVALID_CREDENTIALS', 401);
  }

  // Verificar estado de la empresa asociada
  if (!user.company_is_active || user.company_status === 'suspended') {
    throw new AppError(
      'La empresa asociada a esta cuenta se encuentra suspendida o inactiva.',
      'COMPANY_INACTIVE',
      403
    );
  }

  // Actualizar last_login_at en inicio de sesión exitoso
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  const token = jwt.sign(
    {
      id: user.id,
      role: user.role,
      name: user.name,
      company_id: user.company_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      company_id: user.company_id,
      must_change_password: user.must_change_password,
    },
  };
}

/**
 * Permite a cualquier usuario autenticado cambiar su propia contraseña.
 * Verifica la contraseña actual, valida la política de seguridad para la nueva,
 * impide que sea idéntica a la anterior y marca must_change_password = false.
 *
 * @param {number|string} userId
 * @param {{ current_password, new_password }} data
 */
export async function changePassword(userId, { current_password, new_password }) {
  if (!current_password || !new_password) {
    throw new AppError('Debes ingresar la contraseña actual y la nueva contraseña.', 'MISSING_FIELD', 422);
  }

  const { rows } = await pool.query(
    `SELECT id, password_hash FROM users WHERE id = $1 AND is_active = true`,
    [userId]
  );

  const user = rows[0];
  if (!user) {
    throw new AppError('Usuario no encontrado o inactivo.', 'USER_NOT_FOUND', 404);
  }

  const isCurrentValid = await bcrypt.compare(current_password, user.password_hash);
  if (!isCurrentValid) {
    throw new AppError('La contraseña actual es incorrecta.', 'INVALID_CREDENTIALS', 401);
  }

  if (current_password === new_password) {
    throw new AppError('La nueva contraseña no puede ser idéntica a la anterior.', 'PASSWORD_UNCHANGED', 422);
  }

  const policy = validatePasswordPolicy(new_password);
  if (!policy.valid) {
    throw new AppError(policy.message, 'INVALID_PASSWORD', 422);
  }

  const password_hash = await bcrypt.hash(new_password, SALT_ROUNDS);

  await pool.query(
    `UPDATE users SET password_hash = $1, must_change_password = false, updated_at = NOW() WHERE id = $2`,
    [password_hash, userId]
  );

  return { message: 'Contraseña actualizada correctamente.' };
}
