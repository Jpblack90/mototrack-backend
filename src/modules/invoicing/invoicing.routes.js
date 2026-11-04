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
  listCreditNotes,
  getCreditNoteTicket,
  retryCreditNoteContingency,
} from './invoicing.controller.js';

const router = Router();

// ⚠️  ORDEN CRÍTICO:
//   /pending y /credit-notes... deben ir ANTES de /:id (o Express lo captura como id="pending" o id="credit-notes").
//   /:id/status y /:id/ticket van después de las rutas estáticas.

// RETROFIT Fase 6: middlewares de autenticación y autorización por rol
// El orden de las rutas no fue modificado.

// GET   /api/invoicing/pending               → listar comprobantes en contingencia (RF-28, admin-only)
router.get('/pending', authenticate, authorize('admin'), getPendingContingency);

// Rutas de Notas de Crédito (RF-23)
// GET   /api/invoicing/credit-notes          → listar notas de crédito de la empresa
// GET   /api/invoicing/credit-notes/:id/ticket → ticket térmico de la nota de crédito
// PATCH /api/invoicing/credit-notes/:id/retry  → reintentar contingencia de nota de crédito (admin)
router.get('/credit-notes',             authenticate,                     listCreditNotes);
router.get('/credit-notes/:id/ticket',  authenticate,                     getCreditNoteTicket);
router.patch('/credit-notes/:id/retry', authenticate, authorize('admin'), retryCreditNoteContingency);

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
