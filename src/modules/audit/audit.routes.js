import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize } from '../../shared/middlewares/authorize.js';
import { getAuditLogs } from './audit.controller.js';

const router = Router();

// Consulta de auditoría exclusiva para Administrador
router.get('/', authenticate, authorize('admin'), getAuditLogs);

export default router;
