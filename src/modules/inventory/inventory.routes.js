import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize }    from '../../shared/middlewares/authorize.js';
import {
  getAllItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
} from './inventory.controller.js';

const router = Router();

// RETROFIT Fase 6: middlewares de autenticación y autorización por rol
// Handlers existentes no fueron modificados.

router.get('/',       authenticate,                              getAllItems);
router.get('/:id',    authenticate,                              getItem);
router.post('/',      authenticate, authorize('admin','cajero'), createItem);
router.put('/:id',    authenticate, authorize('admin','cajero'), updateItem);
router.delete('/:id', authenticate, authorize('admin'),          deleteItem);

export default router;
