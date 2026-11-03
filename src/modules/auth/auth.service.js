import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';
import { validatePasswordPolicy } from '../../shared/utils/passwordPolicy.js';
import { validateSunatRuc } from '../company/company.service.js';
import { logAudit } from '../../shared/audit.js';

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
            c.status AS company_status, c.is_active AS company_is_active, c.trial_ends_at,
            c.nombre_comercial, c.razon_social
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

  // Verificar si el periodo de prueba terminó
  if (user.company_status === 'trial' && user.trial_ends_at && new Date(user.trial_ends_at) < new Date()) {
    throw new AppError(
      'Tu periodo de prueba terminó. Contáctanos para activar tu plan.',
      'TRIAL_EXPIRED',
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
      company_name: user.nombre_comercial || user.razon_social || '',
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

/**
 * Registra una nueva empresa y su usuario administrador en una sola transacción atómica.
 * Asigna periodo de prueba de 14 días y emite token para ingreso directo.
 *
 * @param {object} param
 * @param {string} param.razon_social
 * @param {string} [param.nombre_comercial]
 * @param {string} [param.ruc]
 * @param {string} param.admin_name
 * @param {string} param.email
 * @param {string} param.password
 * @param {boolean} param.accept_terms
 */
export async function registerCompany({
  razon_social,
  nombre_comercial,
  ruc,
  admin_name,
  email,
  password,
  accept_terms,
}) {
  // 1. Validaciones previas
  if (!razon_social || String(razon_social).trim() === '') {
    throw new AppError('La razón social es obligatoria.', 'MISSING_FIELD', 422);
  }
  if (String(razon_social).trim().length > 200) {
    throw new AppError('La razón social no puede exceder 200 caracteres.', 'INVALID_FIELD', 422);
  }

  if (!admin_name || String(admin_name).trim() === '') {
    throw new AppError('El nombre del administrador es obligatorio.', 'MISSING_FIELD', 422);
  }
  if (String(admin_name).trim().length > 150) {
    throw new AppError('El nombre del administrador no puede exceder 150 caracteres.', 'INVALID_FIELD', 422);
  }

  if (!email || String(email).trim() === '') {
    throw new AppError('El correo electrónico es obligatorio.', 'MISSING_FIELD', 422);
  }
  const trimmedEmail = String(email).trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) {
    throw new AppError('El correo electrónico no tiene un formato válido.', 'INVALID_FIELD', 422);
  }

  if (accept_terms !== true) {
    throw new AppError('Debes aceptar el tratamiento de datos personales para registrarte.', 'TERMS_NOT_ACCEPTED', 422);
  }

  if (!password) {
    throw new AppError('La contraseña es obligatoria.', 'MISSING_FIELD', 422);
  }
  const policy = validatePasswordPolicy(password);
  if (!policy.valid) {
    throw new AppError(policy.message, 'INVALID_PASSWORD', 422);
  }

  // Validación de RUC si fue provisto
  let sanitizedRuc = null;
  if (ruc !== undefined && ruc !== null && String(ruc).trim() !== '') {
    const trimmedRuc = String(ruc).trim();
    if (!validateSunatRuc(trimmedRuc)) {
      throw new AppError(
        'El RUC no es válido. Debe tener 11 dígitos, prefijo válido (10, 15, 16, 17 o 20) y dígito verificador SUNAT correcto.',
        'INVALID_RUC',
        422
      );
    }
    // Verificar que ninguna empresa ya tenga ese RUC
    const { rows: existingRuc } = await pool.query(
      'SELECT id FROM companies WHERE ruc = $1',
      [trimmedRuc]
    );
    if (existingRuc.length > 0) {
      throw new AppError('El RUC ingresado ya pertenece a otra empresa.', 'RUC_ALREADY_EXISTS', 409);
    }
    sanitizedRuc = trimmedRuc;
  }

  // Validar que el email no esté registrado
  const { rows: existingUser } = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [trimmedEmail]
  );
  if (existingUser.length > 0) {
    throw new AppError(`El correo electrónico "${trimmedEmail}" ya está registrado en el sistema.`, 'EMAIL_ALREADY_EXISTS', 409);
  }

  const sanitizedRazonSocial = String(razon_social).trim();
  const sanitizedNombreComercial = nombre_comercial ? String(nombre_comercial).trim().slice(0, 150) : null;
  const sanitizedAdminName = String(admin_name).trim();

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Crear empresa con status 'trial', 14 días y términos aceptados
    const { rows: compRows } = await client.query(
      `INSERT INTO companies (
         razon_social,
         nombre_comercial,
         ruc,
         status,
         trial_ends_at,
         terms_accepted_at,
         is_active
       )
       VALUES ($1, $2, $3, 'trial', NOW() + INTERVAL '14 days', NOW(), true)
       RETURNING id, razon_social, nombre_comercial, ruc, status, trial_ends_at, terms_accepted_at`,
      [sanitizedRazonSocial, sanitizedNombreComercial, sanitizedRuc]
    );
    const newCompany = compRows[0];

    // 2. Crear usuario admin (must_change_password = false)
    const { rows: userRows } = await client.query(
      `INSERT INTO users (
         company_id,
         name,
         email,
         password_hash,
         role,
         is_active,
         must_change_password
       )
       VALUES ($1, $2, $3, $4, 'admin', true, false)
       RETURNING id, name, email, role, is_active, must_change_password, created_at`,
      [newCompany.id, sanitizedAdminName, trimmedEmail, password_hash]
    );
    const newAdmin = userRows[0];

    // 3. Registrar auditoría de creación de empresa y usuario
    await logAudit(client, {
      companyId: newCompany.id,
      userId: newAdmin.id,
      entity: 'company',
      entityId: newCompany.id,
      action: 'create',
      changes: {
        razon_social: { new: newCompany.razon_social },
        status: { new: 'trial' },
      },
    });

    await logAudit(client, {
      companyId: newCompany.id,
      userId: newAdmin.id,
      entity: 'user',
      entityId: newAdmin.id,
      action: 'create',
      changes: {
        name: { new: newAdmin.name },
        email: { new: newAdmin.email },
        role: { new: 'admin' },
      },
    });

    await client.query('COMMIT');

    // 4. Generar token de sesión idéntico al login
    const token = jwt.sign(
      {
        id: newAdmin.id,
        role: newAdmin.role,
        name: newAdmin.name,
        company_id: newCompany.id,
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    return {
      token,
      user: {
        id: newAdmin.id,
        name: newAdmin.name,
        email: newAdmin.email,
        role: newAdmin.role,
        company_id: newCompany.id,
        company_name: newCompany.nombre_comercial || newCompany.razon_social,
        must_change_password: false,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      if (err.constraint === 'companies_ruc_key') {
        throw new AppError('El RUC ingresado ya pertenece a otra empresa.', 'RUC_ALREADY_EXISTS', 409);
      }
      throw new AppError(`El correo electrónico "${trimmedEmail}" ya está registrado en el sistema.`, 'EMAIL_ALREADY_EXISTS', 409);
    }
    throw err;
  } finally {
    client.release();
  }
}
