import { Router } from 'express';
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

// GET  /api/sales/kits    → listar kits activos con sus componentes expandidos
// POST /api/sales/kits    → crear un kit
router.get('/kits',  getAllKits);
router.post('/kits', createKit);

// GET   /api/sales           → listar ventas (soporta ?status=)
// GET   /api/sales/:id       → una venta con sus ítems expandidos
// POST  /api/sales           → crear venta (transacción real con decremento de stock)
// PATCH /api/sales/:id/void  → anular venta (restaura stock, no emite comprobante fiscal)
router.get('/',          getAllSales);
router.get('/:id',       getSale);
router.post('/',         createSale);
router.patch('/:id/void', voidSale);

export default router;
