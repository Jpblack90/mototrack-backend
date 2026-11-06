import * as notificationsService from './notifications.service.js';

/**
 * GET /api/notifications/pending
 * Lista avisos pendientes de la empresa.
 */
export async function getPendingNotifications(req, res, next) {
  try {
    const data = await notificationsService.getPendingByCompany(req.user.company_id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/notifications/:id/whatsapp-link
 * Genera el enlace de WhatsApp codificado con mensaje prearmado.
 */
export async function getWhatsAppLink(req, res, next) {
  try {
    const data = await notificationsService.getWhatsAppLink(req.params.id, req.user.company_id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/notifications/:id/opened
 * Marca el aviso como abierto (opened) registrando usuario y fecha.
 */
export async function markNotificationOpened(req, res, next) {
  try {
    const data = await notificationsService.markOpened(
      req.params.id,
      req.user.id,
      req.user.company_id
    );
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/notifications/:id/skip
 * Marca el aviso como omitido (skipped).
 */
export async function skipNotification(req, res, next) {
  try {
    const data = await notificationsService.skipNotification(
      req.params.id,
      req.user.company_id
    );
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
