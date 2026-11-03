import pool from '../../config/database.js';

/**
 * Consulta de registros de auditoría filtrados por empresa y criterios opcionales.
 *
 * @param {object} params
 * @param {number} params.companyId       ID de la empresa (aislamiento multi-tenant)
 * @param {string} [params.entity]         Filtrar por entidad ('product', 'sale', 'invoice', 'user', 'company')
 * @param {number|string} [params.entityId] Filtrar por ID de la entidad
 * @param {number|string} [params.userId]   Filtrar por ID del usuario responsable
 * @param {string} [params.action]         Filtrar por tipo de acción
 * @param {string} [params.from]           Fecha de inicio (ISO o YYYY-MM-DD)
 * @param {string} [params.to]             Fecha de fin (ISO o YYYY-MM-DD)
 * @param {number} [params.page=1]         Página actual
 * @param {number} [params.limit=20]       Registros por página (máximo 100)
 */
export async function getAuditLogs({
  companyId,
  entity,
  entityId,
  userId,
  action,
  from,
  to,
  page = 1,
  limit = 20,
}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (p - 1) * l;

  const conditions = ['a.company_id = $1'];
  const values = [companyId];
  let paramIndex = 2;

  if (entity) {
    conditions.push(`a.entity = $${paramIndex++}`);
    values.push(String(entity).trim());
  }

  if (entityId != null && !isNaN(Number(entityId))) {
    conditions.push(`a.entity_id = $${paramIndex++}`);
    values.push(Number(entityId));
  }

  if (userId != null && !isNaN(Number(userId))) {
    conditions.push(`a.user_id = $${paramIndex++}`);
    values.push(Number(userId));
  }

  if (action) {
    conditions.push(`a.action = $${paramIndex++}`);
    values.push(String(action).trim());
  }

  if (from) {
    conditions.push(`a.created_at >= $${paramIndex++}`);
    values.push(new Date(from).toISOString());
  }

  if (to) {
    let toDate;
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      toDate = new Date(`${to}T23:59:59.999Z`);
    } else {
      toDate = new Date(to);
    }
    conditions.push(`a.created_at <= $${paramIndex++}`);
    values.push(toDate.toISOString());
  }

  const whereClause = conditions.join(' AND ');

  // Total count query
  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM audit_logs a
    WHERE ${whereClause}
  `;
  const { rows: countRows } = await pool.query(countQuery, values);
  const total = countRows[0]?.total ?? 0;

  // Data query with JOIN to users
  const dataQuery = `
    SELECT
      a.id,
      a.company_id,
      a.user_id,
      u.name AS user_name,
      u.email AS user_email,
      a.entity,
      a.entity_id,
      a.action,
      a.changes,
      a.created_at
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE ${whereClause}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex++}
  `;

  const { rows: logs } = await pool.query(dataQuery, [...values, l, offset]);

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
