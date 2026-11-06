import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize } from '../../shared/middlewares/authorize.js';
import {
  getPendingNotifications,
  getWhatsAppLink,
  markNotificationOpened,
  skipNotification,
} from './notifications.controller.js';

const router = Router();

// Todas las rutas de notificaciones requieren autenticación y rol admin o cajero (mecánico → 403)
router.use(authenticate, authorize('admin', 'cajero'));

// GET  /api/notifications/pending            → avisos pendientes por enviar (campana)
// ⚠️  ORDEN CRÍTICO: /pending debe ir antes de /:id
router.get('/pending', getPendingNotifications);

// GET  /api/notifications/:id/whatsapp-link  → enlace wa.me con mensaje codificado
router.get('/:id/whatsapp-link', getWhatsAppLink);

// PATCH /api/notifications/:id/opened        → marcar como abierto (idempotente)
router.patch('/:id/opened', markNotificationOpened);

// PATCH /api/notifications/:id/skip          → marcar como omitido
router.patch('/:id/skip', skipNotification);

export default router;
