import * as companyService from './company.service.js';

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

/**
 * GET /api/company
 * Devuelve los datos de configuración de la empresa a la que pertenece el usuario autenticado.
 */
export async function getCompany(req, res, next) {
  try {
    const company = await companyService.getById(req.user.company_id);
    ok(res, company);
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/company
 * Actualiza los datos de configuración de la empresa (solo Administradores).
 */
export async function updateCompany(req, res, next) {
  try {
    const updated = await companyService.update(req.user.company_id, req.body, req.user?.id ?? null);
    ok(res, updated);
  } catch (err) {
    next(err);
  }
}
