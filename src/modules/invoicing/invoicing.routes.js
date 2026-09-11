import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize }    from '../../shared/middlewares/authorize.js';
import {
  getPendingContingency,
  getAllInvoices,
  getInvoice,
  getStatus,
  getTicketData,
  createInvoice,
  retryContingency,
} from './invoicing.controller.js';

const router = Router();

// ⚠️  ORDEN CRÍTICO:
//   /pending debe ir ANTES de /:id (o Express lo captura como id="pending").
//   /:id/status y /:id/ticket van después de las rutas estáticas.

// RETROFIT Fase 6: middlewares de autenticación y autorización por rol
// El orden de las rutas no fue modificado.

// GET  /api/invoicing/pending       → listar comprobantes en contingencia (RF-28, admin-only)
router.get('/pending', authenticate, authorize('admin'), getPendingContingency);

// GET  /api/invoicing               → listar todos (soporta ?estado=)
// GET  /api/invoicing/:id           → un comprobante con datos de la venta
// GET  /api/invoicing/:id/status    → solo { id, estado, is_contingency } (RF-30)
// GET  /api/invoicing/:id/ticket    → datos estructurados para impresión en frontend
// POST /api/invoicing               → emitir comprobante (idempotente por sale_id)
// PATCH /api/invoicing/:id/retry    → reintentar envío de comprobante en contingencia (admin)
router.get('/',             authenticate,                               getAllInvoices);
router.get('/:id',          authenticate,                               getInvoice);
router.get('/:id/status',   authenticate,                               getStatus);
router.get('/:id/ticket',   authenticate,                               getTicketData);
router.post('/',            authenticate, authorize('admin','cajero'),  createInvoice);
router.patch('/:id/retry',  authenticate, authorize('admin'),           retryContingency);

export default router;
