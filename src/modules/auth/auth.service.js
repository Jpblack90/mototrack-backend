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
    `SELECT id, name, email, password_hash, role
     FROM   users
     WHERE  email = $1 AND is_active = true`,
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

  const token = jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    // password_hash NUNCA se incluye en la respuesta
  };
}
