import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize }    from '../../shared/middlewares/authorize.js';
import {
  getAllKits,
  createKit,
  getAllSales,
  getSale,
  createSale,
  voidSale,
} from './sales.controller.js';

const router = Router();

// ⚠️  ORDEN CRÍTICO: /kits debe declararse ANTES de /:id
//    Si /:id estuviera primero, Express interpretaría "kits" como un id
//    numérico y nunca llegaría a estos handlers.

// RETROFIT Fase 6: middlewares de autenticación y autorización por rol
// El orden de las rutas no fue modificado.

// GET  /api/sales/kits    → listar kits activos con sus componentes expandidos
// POST /api/sales/kits    → crear un kit (solo admin, define precios de bundle)
router.get('/kits',  authenticate,                 getAllKits);
router.post('/kits', authenticate, authorize('admin'), createKit);

// GET   /api/sales           → listar ventas (soporta ?status=)
// GET   /api/sales/:id       → una venta con sus ítems expandidos
// POST  /api/sales           → crear venta (transacción real con decremento de stock)
// PATCH /api/sales/:id/void  → anular venta — admin-only: un cajero no anula sus propias ventas
//                              (control anti-fraude: requiere supervisión)
router.get('/',           authenticate,                               getAllSales);
router.get('/:id',        authenticate,                               getSale);
router.post('/',          authenticate, authorize('admin','cajero'),  createSale);
router.patch('/:id/void', authenticate, authorize('admin'),           voidSale);

export default router;
