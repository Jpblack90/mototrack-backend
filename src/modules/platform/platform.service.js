import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';
import { validatePasswordPolicy } from '../../shared/utils/passwordPolicy.js';
import { logAudit } from '../../shared/audit.js';
import { getLimaMonthRange } from '../plans/plan.service.js';
import {
  getLimaDateStr,
  toDateStr,
  diffDays,
  recordPayment,
  getCompanyPayments,
} from '../company/subscription.service.js';

const SALT_ROUNDS = 10;
const INVALID_CREDENTIALS_MSG = 'Email o contraseña incorrectos.';
const VALID_STATUS_FILTERS = ['', 'all', 'trial', 'active', 'grace', 'suspended', 'inactive'];

/**
 * Obtiene y valida PLATFORM_JWT_SECRET del entorno.
 * Si falta o está vacío, registra en consola y lanza AppError 503.
 */
export function requirePlatformSecretOrThrow() {
  const secret = process.env.PLATFORM_JWT_SECRET;
  if (!secret || !secret.trim()) {
    console.error('[PLATFORM] PLATFORM_JWT_SECRET no está definida. Módulo de plataforma deshabilitado (503).');
    throw new AppError(
      'El módulo de plataforma no está configurado en el servidor.',
      'PLATFORM_NOT_CONFIGURED',
      503
    );
  }
  return secret;
}

/**
 * Parsea un ID de ruta y exige entero positivo.
 */
function parsePositiveId(value, fieldName = 'id') {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new AppError(`El parámetro "${fieldName}" debe ser un entero positivo.`, 'INVALID_FIELD', 422);
  }
  return num;
}

/**
 * Genera una contraseña temporal aleatoria que cumple passwordPolicy.js (>= 8 chars, letra + dígito).
 */
function generateTemporaryPassword(length = 12) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;

  const chars = [
    letters[crypto.randomInt(0, letters.length)],
    digits[crypto.randomInt(0, digits.length)],
  ];
  while (chars.length < length) {
    chars.push(all[crypto.randomInt(0, all.length)]);
  }

  // Mezcla Fisher-Yates criptográficamente segura
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  const candidate = chars.join('');
  if (!validatePasswordPolicy(candidate).valid) {
    return generateTemporaryPassword(length);
  }
  return candidate;
}

/**
 * Calcula estado efectivo de suscripción/actividad del taller y días restantes,
 * alineado con subscription.service.js y auth.service.js.
 */
function computeBillingSnapshot(company, hoyStr, graceDays) {
  const paidUntilStr = toDateStr(company.paid_until);

  if (!company.is_active) {
    return {
      subscription_status: 'inactive',
      days_left: 0,
      grace_days_left: 0,
    };
  }

  if (company.company_status === 'suspended' || company.status === 'suspended') {
    return {
      subscription_status: 'suspended',
      days_left: 0,
      grace_days_left: 0,
    };
  }

  const rawStatus = company.company_status ?? company.status;

  if (!paidUntilStr) {
    if (rawStatus === 'trial') {
      let daysLeft = null;
      if (company.trial_ends_at) {
        const trialEndStr = toDateStr(company.trial_ends_at);
        daysLeft = Math.max(0, diffDays(hoyStr, trialEndStr));
      }
      return {
        subscription_status: 'trial',
        days_left: daysLeft,
        grace_days_left: null,
      };
    }

    return {
      subscription_status: 'active',
      days_left: null,
      grace_days_left: null,
    };
  }

  const daysUntilDue = diffDays(hoyStr, paidUntilStr);
  if (daysUntilDue >= 0) {
    return {
      subscription_status: 'active',
      days_left: daysUntilDue,
      grace_days_left: null,
    };
  }

  const daysOverdue = Math.abs(daysUntilDue);
  if (daysOverdue <= graceDays) {
    return {
      subscription_status: 'grace',
      days_left: 0,
      grace_days_left: graceDays - daysOverdue,
    };
  }

  return {
    subscription_status: 'suspended',
    days_left: 0,
    grace_days_left: 0,
  };
}

function getGraceDays() {
  const envGrace = process.env.BILLING_GRACE_DAYS;
  return envGrace !== undefined && envGrace !== '' ? Number(envGrace) : 5;
}

/**
 * Formatea una fila de empresa para /api/platform/companies y /api/platform/companies/:id
 * proyectando exclusivamente metadatos operativos (cero datos de negocio).
 */
function formatCompanyRow(row, hoyStr, graceDays) {
  const billing = computeBillingSnapshot(row, hoyStr, graceDays);

  return {
    id: row.id,
    razon_social: row.razon_social,
    nombre_comercial: row.nombre_comercial,
    ruc: row.ruc,
    is_active: row.is_active,
    company_status: row.company_status,
    subscription_status: billing.subscription_status,
    paid_until: row.paid_until,
    trial_ends_at: row.trial_ends_at,
    days_left: billing.days_left,
    grace_days_left: billing.grace_days_left,
    users_active: Number(row.users_active ?? 0),
    max_users: row.max_users !== null ? Number(row.max_users) : null,
    last_user_login_at: row.last_user_login_at,
    ai_scans_this_month: Number(row.ai_scans_this_month ?? 0),
    max_ai_scans_month: row.max_ai_scans_month !== null ? Number(row.max_ai_scans_month) : null,
    plan: {
      id: row.plan_id,
      code: row.plan_code,
      name: row.plan_name,
      price_pen: Number(row.plan_price_pen),
      max_users: row.max_users !== null ? Number(row.max_users) : null,
      max_ai_scans_month: row.max_ai_scans_month !== null ? Number(row.max_ai_scans_month) : null,
    },
    created_at: row.created_at,
  };
}

/**
 * Helper interno para registrar un evento en platform_audit_logs dentro de la transacción activa.
 */
async function insertPlatformAuditLog(client, {
  platformAdminId,
  action,
  targetCompanyId = null,
  targetUserId = null,
  details = null,
  ip = null,
}) {
  await client.query(
    `INSERT INTO platform_audit_logs (
       platform_admin_id, action, target_company_id, target_user_id, details, ip
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      platformAdminId,
      action,
      targetCompanyId ?? null,
      targetUserId ?? null,
      details ? JSON.stringify(details) : null,
      ip ?? null,
    ]
  );
}

/**
 * Busca un administrador de plataforma por ID (usado por authenticatePlatform).
 */
export async function findPlatformAdminById(id) {
  const { rows } = await pool.query(
    `SELECT id, name, email, is_active, must_change_password, last_login_at
     FROM platform_admins
     WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Login de plataforma: autentica sin company_id y firma JWT con PLATFORM_JWT_SECRET (8h, scope: 'platform').
 */
export async function login({ email, password }) {
  const secret = requirePlatformSecretOrThrow();

  if (!email || !password) {
    throw new AppError(INVALID_CREDENTIALS_MSG, 'INVALID_CREDENTIALS', 401);
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const { rows } = await pool.query(
    `SELECT id, name, email, password_hash, is_active, must_change_password, last_login_at
     FROM platform_admins
     WHERE LOWER(email) = $1`,
    [normalizedEmail]
  );

  const admin = rows[0];
  if (!admin || !admin.is_active) {
    throw new AppError(INVALID_CREDENTIALS_MSG, 'INVALID_CREDENTIALS', 401);
  }

  const passwordMatch = await bcrypt.compare(password, admin.password_hash);
  if (!passwordMatch) {
    throw new AppError(INVALID_CREDENTIALS_MSG, 'INVALID_CREDENTIALS', 401);
  }

  const { rows: updatedRows } = await pool.query(
    `UPDATE platform_admins
     SET last_login_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING last_login_at`,
    [admin.id]
  );

  const token = jwt.sign(
    {
      platform_admin_id: admin.id,
      scope: 'platform',
    },
    secret,
    { expiresIn: '8h' }
  );

  return {
    token,
    admin: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      must_change_password: admin.must_change_password,
      last_login_at: updatedRows[0]?.last_login_at ?? admin.last_login_at,
    },
  };
}

/**
 * Cambio de contraseña del administrador de plataforma autenticado.
 * Valida passwordPolicy.js y registra evento en platform_audit_logs.
 */
export async function changePassword(platformAdminId, { current_password, new_password }, ip = null) {
  if (!current_password || !new_password) {
    throw new AppError('Debes ingresar la contraseña actual y la nueva contraseña.', 'MISSING_FIELD', 422);
  }

  if (current_password === new_password) {
    throw new AppError('La nueva contraseña no puede ser idéntica a la anterior.', 'PASSWORD_UNCHANGED', 422);
  }

  const policy = validatePasswordPolicy(new_password);
  if (!policy.valid) {
    throw new AppError(policy.message, 'INVALID_PASSWORD', 422);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, password_hash
       FROM platform_admins
       WHERE id = $1 AND is_active = true
       FOR UPDATE`,
      [platformAdminId]
    );
    const admin = rows[0];
    if (!admin) {
      throw new AppError('Administrador de plataforma no encontrado o inactivo.', 'ADMIN_NOT_FOUND', 404);
    }

    const isCurrentValid = await bcrypt.compare(current_password, admin.password_hash);
    if (!isCurrentValid) {
      throw new AppError('La contraseña actual es incorrecta.', 'INVALID_CREDENTIALS', 401);
    }

    const passwordHash = await bcrypt.hash(new_password, SALT_ROUNDS);
    await client.query(
      `UPDATE platform_admins
       SET password_hash = $1, must_change_password = false, updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, platformAdminId]
    );

    await insertPlatformAuditLog(client, {
      platformAdminId,
      action: 'platform_password_change',
      details: { summary: 'El administrador de plataforma cambió su contraseña.' },
      ip,
    });

    await client.query('COMMIT');
    return { message: 'Contraseña actualizada correctamente.' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Métricas globales del SaaS (sin exponer datos de negocio de ningún taller).
 */
export async function getMetrics() {
  const hoyStr = getLimaDateStr();
  const graceDays = getGraceDays();
  const { from, to, monthStr } = getLimaMonthRange();

  const { rows: companyRows } = await pool.query(
    `SELECT
       c.id,
       c.status,
       c.is_active,
       c.paid_until::text AS paid_until,
       c.trial_ends_at,
       (c.created_at >= NOW() - INTERVAL '30 days') AS is_recent_30d,
       p.price_pen
     FROM companies c
     JOIN plans p ON p.id = c.plan_id`
  );

  const byStatus = {
    trial: 0,
    active: 0,
    grace: 0,
    suspended: 0,
    inactive: 0,
  };

  let estimatedMonthlyRevenuePen = 0;
  let newCompaniesLast30Days = 0;

  for (const row of companyRows) {
    const billing = computeBillingSnapshot(row, hoyStr, graceDays);
    byStatus[billing.subscription_status] = (byStatus[billing.subscription_status] ?? 0) + 1;

    if (billing.subscription_status === 'active') {
      estimatedMonthlyRevenuePen += Number(row.price_pen) || 0;
    }

    if (row.is_recent_30d) {
      newCompaniesLast30Days += 1;
    }
  }

  const { rows: aiRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM ai_usage
     WHERE success = true
       AND created_at >= $1::timestamptz
       AND created_at < $2::timestamptz`,
    [from, to]
  );

  return {
    total_companies: companyRows.length,
    by_status: byStatus,
    estimated_monthly_revenue_pen: Number(estimatedMonthlyRevenuePen.toFixed(2)),
    ai_scans_this_month: aiRows[0]?.total ?? 0,
    new_companies_last_30_days: newCompaniesLast30Days,
    period: { from, to, month: monthStr },
  };
}

/**
 * Lista de talleres con búsqueda unaccent (razón social, nombre comercial, RUC) y filtro por estado.
 */
export async function listCompanies({ status = '', search = '' } = {}) {
  let normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus === 'inactivo' || normalizedStatus === 'inactivos') {
    normalizedStatus = 'inactive';
  }
  if (!VALID_STATUS_FILTERS.includes(normalizedStatus)) {
    throw new AppError(
      'Estado inválido. Valores permitidos: trial, active, grace, suspended, inactive.',
      'INVALID_FIELD',
      422
    );
  }

  const hoyStr = getLimaDateStr();
  const graceDays = getGraceDays();
  const { from, to } = getLimaMonthRange();

  const cleanSearch = String(search || '').trim();
  const params = [from, to];
  let whereSql = '';

  if (cleanSearch) {
    params.push(`%${cleanSearch}%`);
    whereSql = `
      WHERE (
        unaccent(COALESCE(c.razon_social, '')) ILIKE unaccent($3)
        OR unaccent(COALESCE(c.nombre_comercial, '')) ILIKE unaccent($3)
        OR COALESCE(c.ruc, '') ILIKE $3
      )
    `;
  }

  const { rows } = await pool.query(
    `SELECT
       c.id,
       c.razon_social,
       c.nombre_comercial,
       c.ruc,
       c.is_active,
       c.status AS company_status,
       c.paid_until::text AS paid_until,
       c.trial_ends_at,
       c.created_at,
       p.id AS plan_id,
       p.code AS plan_code,
       p.name AS plan_name,
       p.price_pen AS plan_price_pen,
       p.max_users,
       p.max_ai_scans_month,
       COALESCE(u_stats.users_active, 0)::int AS users_active,
       u_stats.last_user_login_at,
       COALESCE(ai_stats.ai_scans_this_month, 0)::int AS ai_scans_this_month
     FROM companies c
     JOIN plans p ON p.id = c.plan_id
     LEFT JOIN (
       SELECT
         company_id,
         COUNT(*) FILTER (WHERE is_active = true)::int AS users_active,
         MAX(last_login_at) AS last_user_login_at
       FROM users
       GROUP BY company_id
     ) u_stats ON u_stats.company_id = c.id
     LEFT JOIN (
       SELECT
         company_id,
         COUNT(*)::int AS ai_scans_this_month
       FROM ai_usage
       WHERE success = true
         AND created_at >= $1::timestamptz
         AND created_at < $2::timestamptz
       GROUP BY company_id
     ) ai_stats ON ai_stats.company_id = c.id
     ${whereSql}
     ORDER BY c.id ASC`,
    params
  );

  const formatted = rows.map((row) => formatCompanyRow(row, hoyStr, graceDays));

  if (normalizedStatus && normalizedStatus !== 'all') {
    return formatted.filter((c) => c.subscription_status === normalizedStatus);
  }

  return formatted;
}

/**
 * Detalle completo de un taller para soporte: metadatos, plan, pagos, usuarios y solo conteos del mes.
 * Nunca retorna nombres/teléfonos de clientes, placas, montos de ventas ni productos.
 */
export async function getCompanyDetail(companyId) {
  const cId = parsePositiveId(companyId, 'id');
  const hoyStr = getLimaDateStr();
  const graceDays = getGraceDays();
  const { from, to } = getLimaMonthRange();

  const { rows: companyRows } = await pool.query(
    `SELECT
       c.id,
       c.razon_social,
       c.nombre_comercial,
       c.ruc,
       c.is_active,
       c.status AS company_status,
       c.paid_until::text AS paid_until,
       c.trial_ends_at,
       c.created_at,
       p.id AS plan_id,
       p.code AS plan_code,
       p.name AS plan_name,
       p.price_pen AS plan_price_pen,
       p.max_users,
       p.max_ai_scans_month,
       COALESCE(u_stats.users_active, 0)::int AS users_active,
       u_stats.last_user_login_at,
       COALESCE(ai_stats.ai_scans_this_month, 0)::int AS ai_scans_this_month
     FROM companies c
     JOIN plans p ON p.id = c.plan_id
     LEFT JOIN (
       SELECT
         company_id,
         COUNT(*) FILTER (WHERE is_active = true)::int AS users_active,
         MAX(last_login_at) AS last_user_login_at
       FROM users
       GROUP BY company_id
     ) u_stats ON u_stats.company_id = c.id
     LEFT JOIN (
       SELECT
         company_id,
         COUNT(*)::int AS ai_scans_this_month
       FROM ai_usage
       WHERE success = true
         AND created_at >= $1::timestamptz
         AND created_at < $2::timestamptz
       GROUP BY company_id
     ) ai_stats ON ai_stats.company_id = c.id
     WHERE c.id = $3`,
    [from, to, cId]
  );

  if (companyRows.length === 0) {
    throw new AppError(`Taller #${cId} no encontrado.`, 'COMPANY_NOT_FOUND', 404);
  }

  const summary = formatCompanyRow(companyRows[0], hoyStr, graceDays);
  const payments = await getCompanyPayments(cId);

  const { rows: users } = await pool.query(
    `SELECT id, name, email, role, is_active, must_change_password, last_login_at, created_at
     FROM users
     WHERE company_id = $1
     ORDER BY id ASC`,
    [cId]
  );

  const { rows: countRows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int
        FROM invoices
        WHERE company_id = $1
          AND created_at >= $2::timestamptz
          AND created_at < $3::timestamptz) AS invoices_issued,
       (SELECT COUNT(*)::int
        FROM work_orders
        WHERE company_id = $1
          AND created_at >= $2::timestamptz
          AND created_at < $3::timestamptz) AS work_orders_created,
       (SELECT COUNT(*)::int
        FROM products
        WHERE company_id = $1
          AND is_active = true) AS active_products_count`,
    [cId, from, to]
  );

  const counts = countRows[0] || {};

  return {
    ...summary,
    payments,
    users,
    monthly_counts: {
      invoices_issued: counts.invoices_issued ?? 0,
      work_orders_created: counts.work_orders_created ?? 0,
      active_products_count: counts.active_products_count ?? 0,
    },
  };
}

/**
 * Restablece la contraseña de un usuario de un taller con contraseña temporal aleatoria.
 * Obliga cambio al ingresar (must_change_password = true) y audita en plataforma + taller.
 */
export async function resetCompanyUserPassword(companyId, userId, platformAdmin, ip = null) {
  const cId = parsePositiveId(companyId, 'id');
  const uId = parsePositiveId(userId, 'userId');

  const temporaryPassword = generateTemporaryPassword(12);
  const passwordHash = await bcrypt.hash(temporaryPassword, SALT_ROUNDS);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: compRows } = await client.query(
      `SELECT id FROM companies WHERE id = $1`,
      [cId]
    );
    if (compRows.length === 0) {
      throw new AppError(`Taller #${cId} no encontrado.`, 'COMPANY_NOT_FOUND', 404);
    }

    const { rows: userRows } = await client.query(
      `SELECT id, company_id, name, email, role, is_active, must_change_password
       FROM users
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [uId, cId]
    );
    const targetUser = userRows[0];
    if (!targetUser) {
      throw new AppError(`Usuario #${uId} no encontrado en el taller #${cId}.`, 'USER_NOT_FOUND', 404);
    }

    await client.query(
      `UPDATE users
       SET password_hash = $1, must_change_password = true, updated_at = NOW()
       WHERE id = $2 AND company_id = $3`,
      [passwordHash, uId, cId]
    );

    const summary = `Soporte MotoTrack restableció la contraseña de ${targetUser.name}`;

    await insertPlatformAuditLog(client, {
      platformAdminId: platformAdmin.id,
      action: 'user_password_reset',
      targetCompanyId: cId,
      targetUserId: uId,
      details: {
        summary,
        target_user_name: targetUser.name,
        target_user_email: targetUser.email,
        target_user_role: targetUser.role,
        must_change_password: true,
      },
      ip,
    });

    await logAudit(client, {
      companyId: cId,
      userId: null,
      entity: 'platform_support',
      entityId: uId,
      action: 'password_reset',
      changes: {
        message: summary,
        actor_type: 'platform_admin',
        platform_admin_id: platformAdmin.id,
        platform_admin_name: platformAdmin.name,
        target_user_id: uId,
        target_user_name: targetUser.name,
        must_change_password: { old: targetUser.must_change_password, new: true },
      },
    });

    await client.query('COMMIT');

    return {
      user: {
        id: targetUser.id,
        company_id: targetUser.company_id,
        name: targetUser.name,
        email: targetUser.email,
        role: targetUser.role,
        must_change_password: true,
      },
      temporary_password: temporaryPassword,
      message: `Contraseña temporal generada para ${targetUser.name}. Muéstrala una sola vez.`,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Suspende (is_active = false) o reactiva (is_active = true) un taller con motivo obligatorio (10-300 chars).
 */
export async function updateCompanyStatus(companyId, { is_active, reason }, platformAdmin, ip = null) {
  const cId = parsePositiveId(companyId, 'id');

  if (typeof is_active !== 'boolean') {
    throw new AppError('El campo "is_active" debe ser un booleano.', 'INVALID_FIELD', 422);
  }

  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (cleanReason.length < 10 || cleanReason.length > 300) {
    throw new AppError(
      'El campo "reason" es obligatorio y debe tener entre 10 y 300 caracteres.',
      'INVALID_REASON',
      422
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: compRows } = await client.query(
      `SELECT id, razon_social, nombre_comercial, is_active, status
       FROM companies
       WHERE id = $1
       FOR UPDATE`,
      [cId]
    );
    const current = compRows[0];
    if (!current) {
      throw new AppError(`Taller #${cId} no encontrado.`, 'COMPANY_NOT_FOUND', 404);
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE companies
       SET is_active = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, razon_social, nombre_comercial, ruc, is_active, status,
                 paid_until::text AS paid_until, trial_ends_at, updated_at`,
      [is_active, cId]
    );
    const updated = updatedRows[0];

    const platformAction = is_active ? 'company_reactivate' : 'company_suspend';
    const workshopAction = is_active ? 'reactivate' : 'suspend';
    const summary = is_active
      ? `Soporte MotoTrack reactivó el taller: ${cleanReason}`
      : `Soporte MotoTrack suspendió el taller: ${cleanReason}`;

    await insertPlatformAuditLog(client, {
      platformAdminId: platformAdmin.id,
      action: platformAction,
      targetCompanyId: cId,
      targetUserId: null,
      details: {
        summary,
        reason: cleanReason,
        is_active: { old: current.is_active, new: is_active },
      },
      ip,
    });

    await logAudit(client, {
      companyId: cId,
      userId: null,
      entity: 'platform_support',
      entityId: cId,
      action: workshopAction,
      changes: {
        message: summary,
        actor_type: 'platform_admin',
        platform_admin_id: platformAdmin.id,
        platform_admin_name: platformAdmin.name,
        reason: cleanReason,
        is_active: { old: current.is_active, new: is_active },
      },
    });

    await client.query('COMMIT');

    return {
      ...updated,
      reason: cleanReason,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Registra un pago de suscripción reutilizando recordPayment() de subscription.service.js
 * dentro de la misma transacción que la auditoría de plataforma y soporte al taller.
 */
export async function registerCompanyPayment(companyId, { amount, method, reference, months, notes }, platformAdmin, ip = null) {
  const cId = parsePositiveId(companyId, 'id');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await recordPayment({
      companyId: cId,
      amount,
      method,
      reference,
      months,
      notes,
      client,
    });

    const summary = `Soporte MotoTrack registró un pago de suscripción (S/ ${result.payment.amount.toFixed(2)}, ${result.payment.months} mes/es, ${result.payment.method})`;

    await insertPlatformAuditLog(client, {
      platformAdminId: platformAdmin.id,
      action: 'subscription_payment',
      targetCompanyId: cId,
      targetUserId: null,
      details: {
        summary,
        payment_id: result.payment.id,
        amount: result.payment.amount,
        method: result.payment.method,
        reference: result.payment.reference,
        months: result.payment.months,
        period_from: result.payment.period_from,
        period_to: result.payment.period_to,
        paid_until: { old: result.previous.paid_until, new: result.company.paid_until },
      },
      ip,
    });

    await logAudit(client, {
      companyId: cId,
      userId: null,
      entity: 'platform_support',
      entityId: result.payment.id,
      action: 'subscription_payment',
      changes: {
        message: summary,
        actor_type: 'platform_admin',
        platform_admin_id: platformAdmin.id,
        platform_admin_name: platformAdmin.name,
        payment_id: result.payment.id,
        amount: result.payment.amount,
        method: result.payment.method,
        months: result.payment.months,
        period_from: result.payment.period_from,
        period_to: result.payment.period_to,
      },
    });

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Consulta paginada de platform_audit_logs con filtro opcional por company_id y action.
 */
export async function getPlatformAuditLogs({ companyId, action, page = 1, limit = 50 } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (p - 1) * l;

  const conditions = [];
  const values = [];
  let idx = 1;

  if (companyId !== undefined && companyId !== '') {
    const cId = parsePositiveId(companyId, 'company_id');
    conditions.push(`pal.target_company_id = $${idx++}`);
    values.push(cId);
  }

  if (action !== undefined && String(action).trim() !== '') {
    conditions.push(`pal.action = $${idx++}`);
    values.push(String(action).trim());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM platform_audit_logs pal
     ${whereClause}`,
    values
  );
  const total = countRows[0]?.total ?? 0;

  const { rows: logs } = await pool.query(
    `SELECT
       pal.id,
       pal.platform_admin_id,
       pa.name AS platform_admin_name,
       pa.email AS platform_admin_email,
       pal.action,
       pal.target_company_id,
       COALESCE(c.nombre_comercial, c.razon_social) AS target_company_name,
       pal.target_user_id,
       u.name AS target_user_name,
       u.email AS target_user_email,
       pal.details,
       pal.ip,
       pal.created_at
     FROM platform_audit_logs pal
     JOIN platform_admins pa ON pa.id = pal.platform_admin_id
     LEFT JOIN companies c ON c.id = pal.target_company_id
     LEFT JOIN users u ON u.id = pal.target_user_id
     ${whereClause}
     ORDER BY pal.created_at DESC, pal.id DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, l, offset]
  );

  return {
    logs,
    pagination: {
      total,
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l) || 1,
    },
  };
}
