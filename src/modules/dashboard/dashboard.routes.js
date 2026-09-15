import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize }    from '../../shared/middlewares/authorize.js';
import {
  getFullDashboard,
  getSalesSummary,
  getInventorySummary,
  getWorkOrdersSummary,
  getInvoicingSummary,
} from './dashboard.controller.js';

const router = Router();

// Todas las rutas son admin-only — el dashboard expone métricas de negocio
// que no deben ser visibles para cajeros ni mecánicos.
const guard = [authenticate, authorize('admin')];

router.get('/',           ...guard, getFullDashboard);
router.get('/sales',      ...guard, getSalesSummary);
router.get('/inventory',  ...guard, getInventorySummary);
router.get('/workorders', ...guard, getWorkOrdersSummary);
router.get('/invoicing',  ...guard, getInvoicingSummary);

export default router;
