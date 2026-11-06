import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';
import { normalizePhonePE } from '../../shared/utils/phonePE.js';

/**
 * Obtiene todos los avisos pendientes de la empresa (status = 'pending').
 * Incluye datos enriquecidos de la orden y del vehículo para la campana de alertas.
 *
 * @param {number} companyId
 * @returns {Promise<Array>}
 */
export async function getPendingByCompany(companyId) {
  const { rows } = await pool.query(
    `SELECT n.id, n.work_order_id, n.message, n.channel, n.status, n.event, n.created_at,
            v.placa, v.customer_name AS cliente, v.customer_phone AS telefono
     FROM notifications n
     JOIN work_orders wo ON wo.id = n.work_order_id
     JOIN vehicles v ON v.id = wo.vehicle_id
     WHERE n.company_id = $1 AND n.status = 'pending'
     ORDER BY n.created_at ASC`,
    [companyId]
  );
  return rows;
}

/**
 * Genera el enlace de WhatsApp (wa.me) con el mensaje codificado.
 * Valida que el aviso pertenezca a la empresa y que el vehículo tenga consentimiento activo y celular válido.
 *
 * @param {number|string} notificationId
 * @param {number} companyId
 * @returns {Promise<{ url: string, phone: string, message: string }>}
 */
export async function getWhatsAppLink(notificationId, companyId) {
  const { rows } = await pool.query(
    `SELECT n.id, n.message, n.status, n.event,
            v.customer_phone, v.whatsapp_opt_in
     FROM notifications n
     JOIN work_orders wo ON wo.id = n.work_order_id
     JOIN vehicles v ON v.id = wo.vehicle_id
     WHERE n.id = $1 AND n.company_id = $2`,
    [notificationId, companyId]
  );

  if (!rows[0]) {
    throw new AppError(`Aviso #${notificationId} no encontrado.`, 'NOTIFICATION_NOT_FOUND', 404);
  }

  const { message, customer_phone, whatsapp_opt_in } = rows[0];

  const phone = normalizePhonePE(customer_phone);
  if (!whatsapp_opt_in || !phone) {
    throw new AppError(
      'El cliente no dio su consentimiento o no tiene celular válido.',
      'WHATSAPP_NOT_ELIGIBLE',
      422
    );
  }

  const encoded = encodeURIComponent(message);
  const url = `https://wa.me/${phone}?text=${encoded}`;

  return {
    url,
    phone,
    message,
  };
}

/**
 * Marca un aviso como abierto (status = 'opened').
 * Es idempotente: si ya estaba abierta, conserva opened_at y opened_by originales.
 *
 * @param {number|string} notificationId
 * @param {number} userId
 * @param {number} companyId
 * @returns {Promise<object>}
 */
export async function markOpened(notificationId, userId, companyId) {
  const { rows: current } = await pool.query(
    `SELECT id, status, opened_at, opened_by FROM notifications WHERE id = $1 AND company_id = $2`,
    [notificationId, companyId]
  );

  if (!current[0]) {
    throw new AppError(`Aviso #${notificationId} no encontrado.`, 'NOTIFICATION_NOT_FOUND', 404);
  }

  // Idempotente: si ya estaba abierta, no cambia la fecha ni el usuario
  if (current[0].status === 'opened') {
    return current[0];
  }

  const { rows } = await pool.query(
    `UPDATE notifications
     SET status = 'opened', opened_at = NOW(), opened_by = $1
     WHERE id = $2 AND company_id = $3
     RETURNING *`,
    [userId, notificationId, companyId]
  );

  return rows[0];
}

/**
 * Marca un aviso como omitido (status = 'skipped') cuando el taller avisó por otro medio.
 *
 * @param {number|string} notificationId
 * @param {number} companyId
 * @returns {Promise<object>}
 */
export async function skipNotification(notificationId, companyId) {
  const { rows: current } = await pool.query(
    `SELECT id FROM notifications WHERE id = $1 AND company_id = $2`,
    [notificationId, companyId]
  );

  if (!current[0]) {
    throw new AppError(`Aviso #${notificationId} no encontrado.`, 'NOTIFICATION_NOT_FOUND', 404);
  }

  const { rows } = await pool.query(
    `UPDATE notifications
     SET status = 'skipped'
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [notificationId, companyId]
  );

  return rows[0];
}
