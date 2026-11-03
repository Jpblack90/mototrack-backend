import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Limitador para inicio de sesión por cuenta (IP + Email):
 * Máximo 10 intentos fallidos cada 15 minutos por IP + correo.
 * `skipSuccessfulRequests: true` asegura que solo los intentos fallidos
 * (códigos HTTP 4xx y 5xx) consuman el límite.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode < 400 || res.statusCode === 403,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}_${(req.body?.email || '').toLowerCase().trim()}`,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        message: 'Demasiados intentos. Espera unos minutos.',
        code: 'TOO_MANY_REQUESTS',
      },
    });
  },
});

/**
 * Limitador para inicio de sesión global por IP:
 * Máximo 50 intentos fallidos cada 15 minutos desde la misma IP,
 * protegiendo contra ataques de fuerza bruta distribuidos o enumeración de contraseñas.
 */
export const loginIpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode < 400 || res.statusCode === 403,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        message: 'Demasiados intentos. Espera unos minutos.',
        code: 'TOO_MANY_REQUESTS',
      },
    });
  },
});

/**
 * Limitador para registro público de talleres:
 * Máximo 5 intentos por hora por IP para prevenir abuso, DoS o enumeración de clientes (409).
 * Se computan todos los intentos (exitosos y fallidos).
 */
export const registerCompanyRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        message: 'Demasiados intentos. Espera unos minutos.',
        code: 'TOO_MANY_REQUESTS',
      },
    });
  },
});
