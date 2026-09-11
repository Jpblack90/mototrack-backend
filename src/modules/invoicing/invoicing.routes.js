import { Router } from 'express';
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

// GET  /api/invoicing/pending       → listar comprobantes en contingencia (RF-28)
router.get('/pending', getPendingContingency);

// GET  /api/invoicing               → listar todos (soporta ?estado=)
// GET  /api/invoicing/:id           → un comprobante con datos de la venta
// GET  /api/invoicing/:id/status    → solo { id, estado, is_contingency } (RF-30)
// GET  /api/invoicing/:id/ticket    → datos estructurados para impresión en frontend
// POST /api/invoicing               → emitir comprobante (idempotente por sale_id)
// PATCH /api/invoicing/:id/retry    → reintentar envío de comprobante en contingencia
router.get('/',               getAllInvoices);
router.get('/:id',            getInvoice);
router.get('/:id/status',     getStatus);
router.get('/:id/ticket',     getTicketData);
router.post('/',              createInvoice);
router.patch('/:id/retry',    retryContingency);

export default router;
