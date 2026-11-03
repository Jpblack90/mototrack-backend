import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../../config/database.js';

class AppError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Mensaje genérico para login fallido — NUNCA revelar si el email o la
// contraseña fueron lo que falló (seguridad anti-enumeración de usuarios).
const INVALID_CREDENTIALS_MSG = 'Email o contraseña incorrectos.';

/**
 * Login: verifica credenciales y emite un JWT de 8 horas.
 * @param {{ email, password }} param
 * @returns {{ token, user }}
 */
export async function login({ email, password }) {
  if (!email || !password) {
    throw new AppError(INVALID_CREDENTIALS_MSG, 'INVALID_CREDENTIALS', 401);
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.company_id,
            c.status AS company_status, c.is_active AS company_is_active
     FROM   users u
     JOIN   companies c ON c.id = u.company_id
     WHERE  u.email = $1 AND u.is_active = true`,
    [email.trim().toLowerCase()]
  );

  // Si el email no existe → mismo mensaje que contraseña incorrecta
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
    },
    // password_hash NUNCA se incluye en la respuesta
  };
}
