import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize } from '../../shared/middlewares/authorize.js';
import { getCompany, updateCompany, getCompanyPlan } from './company.controller.js';

const router = Router();

// GET /api/company/plan -> cualquier rol autenticado de la empresa
router.get('/plan', authenticate, getCompanyPlan);

// GET /api/company -> cualquier usuario autenticado de la empresa
router.get('/', authenticate, getCompany);

// PUT /api/company -> solo administradores
router.put('/', authenticate, authorize('admin'), updateCompany);

export default router;
