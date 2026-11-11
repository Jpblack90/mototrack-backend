import jwt from 'jsonwebtoken';
import {
  findPlatformAdminById,
  requirePlatformSecretOrThrow,
} from '../../modules/platform/platform.service.js';

function respondUnavailable(res) {
  return res.status(503).json({
    success: false,
    error: {
      message: 'El módulo de plataforma no está configurado en el servidor.',
      code: 'PLATFORM_NOT_CONFIGURED',
    },
  });
}

/**
 * Middleware que verifica que PLATFORM_JWT_SECRET esté definida.
 * Si falta, registra en consola y responde HTTP 503 sin afectar el resto de módulos.
 */
export function ensurePlatformConfigured(_req, res, next) {
  try {
    requirePlatformSecretOrThrow();
    return next();
  } catch {
    return respondUnavailable(res);
  }
}

/**
 * Fábrica de middleware de autenticación exclusivo para administradores de plataforma.
 */
function createAuthenticatePlatform({ allowMustChangePassword = false } = {}) {
  return async function authenticatePlatformMiddleware(req, res, next) {
    let secret;
    try {
      secret = requirePlatformSecretOrThrow();
    } catch {
      return respondUnavailable(res);
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: { message: 'Token de plataforma requerido.', code: 'TOKEN_MISSING' },
      });
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return res.status(401).json({
        success: false,
        error: { message: 'Token de plataforma vacío.', code: 'TOKEN_MISSING' },
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({
        success: false,
        error: { message: 'Token de plataforma inválido o expirado.', code: 'TOKEN_INVALID' },
      });
    }

    if (
      payload.scope !== 'platform' ||
      !payload.platform_admin_id ||
      payload.company_id !== undefined
    ) {
      return res.status(401).json({
        success: false,
        error: { message: 'Token sin alcance válido para plataforma.', code: 'TOKEN_INVALID_SCOPE' },
      });
    }

    try {
      const admin = await findPlatformAdminById(payload.platform_admin_id);
      if (!admin || !admin.is_active) {
        return res.status(401).json({
          success: false,
          error: {
            message: 'Cuenta de plataforma no encontrada o inactiva.',
            code: 'PLATFORM_ADMIN_INACTIVE',
          },
        });
      }

      if (admin.must_change_password && !allowMustChangePassword) {
        return res.status(403).json({
          success: false,
          error: {
            message: 'Debes cambiar tu contraseña temporal antes de usar el panel de plataforma.',
            code: 'PASSWORD_CHANGE_REQUIRED',
          },
        });
      }

      req.platformAdmin = {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        must_change_password: admin.must_change_password,
        last_login_at: admin.last_login_at,
      };

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export const authenticatePlatform = createAuthenticatePlatform({ allowMustChangePassword: false });
export const authenticatePlatformPasswordChange = createAuthenticatePlatform({ allowMustChangePassword: true });
