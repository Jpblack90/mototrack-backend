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
} from './inventory.controller.js';

const router = Router();

// RETROFIT Fase 6: middlewares de autenticación y autorización por rol
// Handlers existentes no fueron modificados.

router.get('/',       authenticate,                              getAllItems);

// ⚠️  ORDEN CRÍTICO (Fase 8): POST /scan DEBE declararse ANTES de GET /:id.
//    Si /:id estuviera primero, Express interpretaría la cadena "scan" como un
//    id numérico y el handler de escaneo nunca se alcanzaría.
router.post('/scan',  authenticate, authorize('admin','cajero'), scanProduct);

router.get('/:id',    authenticate,                              getItem);
router.post('/',      authenticate, authorize('admin','cajero'), createItem);
router.put('/:id',    authenticate, authorize('admin','cajero'), updateItem);
router.delete('/:id', authenticate, authorize('admin'),          deleteItem);

export default router;
