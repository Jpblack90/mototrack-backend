import * as companyService from './company.service.js';
import { getUsage } from '../plans/plan.service.js';

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

/**
 * GET /api/company/plan
 * Devuelve la información del plan comercial y el consumo actual de la empresa.
 * Accesible para cualquier rol autenticado de la empresa.
 */
export async function getCompanyPlan(req, res, next) {
  try {
    const planUsage = await getUsage(req.user.company_id);
    ok(res, planUsage);
  } catch (err) {
    next(err);
  }
}
