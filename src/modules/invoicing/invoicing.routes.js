import { Router } from 'express';
import {
  getAllInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  deleteInvoice,
} from './invoicing.controller.js';

const router = Router();

// GET /api/invoicing — módulo activo
router.get('/', getAllInvoices);
router.get('/:id', getInvoice);
router.post('/', createInvoice);
router.put('/:id', updateInvoice);
router.delete('/:id', deleteInvoice);

export default router;
