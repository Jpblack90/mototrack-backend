import * as auditService from './audit.service.js';

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

/**
 * GET /api/audit
 * Consulta de registros de auditoría para la empresa del usuario autenticado (solo Admin).
 */
export async function getAuditLogs(req, res, next) {
  try {
    const {
      entity,
      entity_id,
      user_id,
      action,
      from,
      to,
      page,
      limit,
    } = req.query;

    const result = await auditService.getAuditLogs({
      companyId: req.user.company_id,
      entity,
      entityId: entity_id,
      userId: user_id,
      action,
      from,
      to,
      page,
      limit,
    });

    ok(res, result);
  } catch (err) {
    next(err);
  }
}
