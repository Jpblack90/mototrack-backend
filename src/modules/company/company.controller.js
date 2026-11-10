import * as companyService from './company.service.js';
import { getUsage } from '../plans/plan.service.js';
import { getCompanyPayments } from './subscription.service.js';

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
 * Devuelve la información del plan comercial, consumo y estado de facturación (billing).
 * Accesible para cualquier rol autenticado de la empresa (las instrucciones solo para admin).
 */
export async function getCompanyPlan(req, res, next) {
  try {
    const planUsage = await getUsage(req.user.company_id, req.user?.role ?? null);
    ok(res, planUsage);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/company/payments
 * Devuelve el historial de pagos de suscripción de la empresa (solo Administradores).
 */
export async function getPayments(req, res, next) {
  try {
    const payments = await getCompanyPayments(req.user.company_id);
    ok(res, payments);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/company/pse/test
 * Prueba la conectividad con Nubefact usando consultar_comprobante (solo Administradores).
 */
export async function testPse(req, res, next) {
  try {
    const result = await companyService.testPseConnection(req.user.company_id, req.body);
    ok(res, result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/company/series
 * Devuelve las series configuradas de la empresa con sus correlativos actuales.
 */
export async function getCompanySeries(req, res, next) {
  try {
    const series = await companyService.getSeries(req.user.company_id);
    ok(res, series);
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/company/series/:serie
 * Ajusta el correlativo inicial o último número de una serie (solo Administradores).
 */
export async function updateSerie(req, res, next) {
  try {
    const { last_number } = req.body;
    const result = await companyService.updateSerieCorrelative(
      req.user.company_id,
      req.params.serie,
      last_number,
      req.user?.id ?? null
    );
    ok(res, result);
  } catch (err) {
    next(err);
  }
}
