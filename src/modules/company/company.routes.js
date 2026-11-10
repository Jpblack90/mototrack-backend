import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize } from '../../shared/middlewares/authorize.js';
import {
  getCompany,
  updateCompany,
  getCompanyPlan,
  testPse,
  getCompanySeries,
  updateSerie,
} from './company.controller.js';

const router = Router();

// GET /api/company/plan -> cualquier rol autenticado de la empresa
router.get('/plan', authenticate, getCompanyPlan);

// GET /api/company/series -> cualquier rol autenticado de la empresa
router.get('/series', authenticate, getCompanySeries);

// PUT /api/company/series/:serie -> solo administradores
router.put('/series/:serie', authenticate, authorize('admin'), updateSerie);

// POST /api/company/pse/test -> solo administradores
router.post('/pse/test', authenticate, authorize('admin'), testPse);

// GET /api/company -> cualquier usuario autenticado de la empresa
router.get('/', authenticate, getCompany);

// PUT /api/company -> solo administradores
router.put('/', authenticate, authorize('admin'), updateCompany);

export default router;
