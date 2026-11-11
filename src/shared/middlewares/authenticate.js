import jwt from 'jsonwebtoken';
import pool from '../../config/database.js';
import { getLimaDateStr, toDateStr } from '../../modules/company/subscription.service.js';

/**
 * Middleware de autenticación JWT con revocación inmediata y rol sincronizado en vivo.
 * Verifica la firma del JWT y consulta en base de datos el estado activo del usuario
 * y de su empresa (no suspendida).
 */
export async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: { message: 'Acceso no autorizado. Se requiere token Bearer.', code: 'UNAUTHORIZED' },
    });
  }

  const token = authHeader.slice(7); // quita "Bearer "

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({
      success: false,
      error: { message: 'Token inválido o expirado.', code: 'TOKEN_INVALID' },
    });
  }

  // Aislar tokens de plataforma: nunca pueden acceder a endpoints de taller
  if (payload.scope === 'platform' || payload.platform_admin_id) {
    return res.status(401).json({
      success: false,
      error: {
        message: 'Token de plataforma no válido para endpoints de taller.',
        code: 'TOKEN_INVALID_SCOPE',
      },
    });
  }

  if (!payload.company_id || !payload.id) {
    return res.status(401).json({
      success: false,
      error: {
        message: 'Token sin empresa o usuario asignado. Por favor, inicia sesión nuevamente.',
        code: 'TOKEN_INVALID_PAYLOAD',
      },
    });
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_active AS user_active, u.company_id, u.must_change_password,
              c.is_active AS company_active, c.status AS company_status, c.trial_ends_at, c.paid_until::text AS paid_until
       FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1 AND u.company_id = $2`,
      [payload.id, payload.company_id]
    );

    const user = rows[0];
    if (!user || !user.user_active) {
      return res.status(401).json({
        success: false,
        error: { message: 'Usuario inactivo o no encontrado.', code: 'USER_INACTIVE' },
      });
    }

    if (!user.company_active || user.company_status === 'suspended') {
      const paidUntilStr = toDateStr(user.paid_until);
      const hoyStr = getLimaDateStr();
      if (user.company_status === 'suspended' && paidUntilStr && paidUntilStr < hoyStr) {
        const instructions = process.env.PAYMENT_INSTRUCTIONS ? process.env.PAYMENT_INSTRUCTIONS.trim() : '';
        const msg = `Tu suscripción venció el ${paidUntilStr}. Realiza el pago para reactivar tu cuenta.${instructions ? ' ' + instructions : ''}`;
        return res.status(403).json({
          success: false,
          error: {
            message: msg,
            code: 'SUBSCRIPTION_EXPIRED',
          },
        });
      }

      return res.status(401).json({
        success: false,
        error: {
          message: 'La empresa asociada se encuentra inactiva o suspendida.',
          code: 'COMPANY_INACTIVE',
        },
      });
    }

    if (user.company_status === 'trial' && user.trial_ends_at && new Date(user.trial_ends_at) < new Date()) {
      return res.status(403).json({
        success: false,
        error: {
          message: 'Tu periodo de prueba terminó. Contáctanos para activar tu plan.',
          code: 'TRIAL_EXPIRED',
        },
      });
    }

    // Carga los datos frescos de la BD para reflejar de inmediato cualquier cambio de rol
    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      company_id: user.company_id,
      must_change_password: user.must_change_password,
    };

    next();
  } catch (err) {
    next(err);
  }
}
