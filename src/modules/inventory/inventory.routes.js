import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize }    from '../../shared/middlewares/authorize.js';
import {
  getAllItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  scanProduct,
  getAlerts,
  getAlternatives,
  recordStockEntry,
} from './inventory.controller.js';

const router = Router();

// RETROFIT Fase 6: middlewares de autenticación y autorización por rol
// Handlers existentes no fueron modificados.

router.get('/',                  authenticate,                                           getAllItems);

// ⚠️  ORDEN CRÍTICO: /alerts y POST /scan DEBEN declararse ANTES de GET /:id.
//    Si /:id estuviera primero, Express interpretaría "alerts" o "scan" como un
//    id numérico y los handlers nunca se alcanzarían.
router.get('/alerts',            authenticate, authorize('admin','cajero','almacenero'), getAlerts);
router.post('/scan',             authenticate, authorize('admin','cajero','almacenero'), scanProduct);

router.post('/:id/stock-entry',  authenticate, authorize('admin','cajero','almacenero'), recordStockEntry);
router.get('/:id/alternatives',  authenticate,                                           getAlternatives);
router.get('/:id',               authenticate,                                           getItem);
router.post('/',      authenticate, authorize('admin','cajero','almacenero'), createItem);
router.put('/:id',    authenticate, authorize('admin','cajero','almacenero'), updateItem);
router.delete('/:id', authenticate, authorize('admin'),          deleteItem);

export default router;
