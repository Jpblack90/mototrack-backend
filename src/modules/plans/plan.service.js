import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';

/**
 * Calcula el rango del mes actual en la zona horaria America/Lima
 * (del día 1 a las 00:00:00 al primer día del mes siguiente a las 00:00:00).
 */
export function getLimaMonthRange() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
  });
  const currentMonth = formatter.format(new Date()).slice(0, 7); // 'YYYY-MM'
  const [yearStr, monthStr] = currentMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const from = `${year}-${String(month).padStart(2, '0')}-01T00:00:00-05:00`;
  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  const to = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00-05:00`;

  return { from, to, monthStr: currentMonth };
}

/**
 * Consulta la información del plan comercial y el consumo actual de la empresa.
 * NUNCA expone costos en dólares ni conteos internos de tokens.
 *
 * @param {number} companyId ID de la empresa
 * @returns {Promise<object>} Métricas de uso y límites del plan
 */
export async function getUsage(companyId) {
  if (!companyId) {
    throw new AppError('companyId es requerido para consultar el plan.', 'INVALID_COMPANY', 400);
  }

  // 1. Obtener plan asignado a la empresa y estado de la empresa
  const { rows: planRows } = await pool.query(
    `SELECT 
       p.name,
       p.price_pen,
       p.max_users,
       p.max_ai_scans_month,
       p.features,
       c.status,
       c.trial_ends_at
     FROM companies c
     JOIN plans p ON p.id = c.plan_id
     WHERE c.id = $1`,
    [companyId]
  );

  if (planRows.length === 0) {
    throw new AppError('Empresa o plan no encontrado.', 'PLAN_NOT_FOUND', 404);
  }

  const row = planRows[0];

  // 2. Conteo de usuarios activos
  const { rows: userRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM users WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );
  const usersActive = userRows[0]?.count ?? 0;

  // 3. Conteo de escaneos IA exitosos en el mes actual en America/Lima
  const { from, to } = getLimaMonthRange();
  const { rows: scanRows } = await pool.query(
    `SELECT COUNT(*)::int AS count 
     FROM ai_usage 
     WHERE company_id = $1 
       AND success = true 
       AND created_at >= $2::timestamptz 
       AND created_at < $3::timestamptz`,
    [companyId, from, to]
  );
  const aiScansThisMonth = scanRows[0]?.count ?? 0;

  // 4. Calcular días restantes de prueba si aplica
  let daysLeft = null;
  if (row.status === 'trial' && row.trial_ends_at) {
    const diffMs = new Date(row.trial_ends_at).getTime() - Date.now();
    daysLeft = diffMs > 0 ? Math.ceil(diffMs / (1000 * 60 * 60 * 24)) : 0;
  }

  return {
    plan: {
      name: row.name,
      price_pen: Number(row.price_pen),
      max_users: row.max_users !== null ? Number(row.max_users) : null,
      max_ai_scans_month: row.max_ai_scans_month !== null ? Number(row.max_ai_scans_month) : null,
      features: row.features || {},
    },
    users_active: usersActive,
    ai_scans_this_month: aiScansThisMonth,
    period: { from, to },
    status: row.status,
    days_left: daysLeft,
  };
}
