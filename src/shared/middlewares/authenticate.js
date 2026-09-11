import jwt from 'jsonwebtoken';

/**
 * Middleware de autenticación JWT.
 * Lee el header "Authorization: Bearer <token>", lo verifica y carga
 * req.user = { id, role, name } para los middlewares siguientes.
 */
export function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: { message: 'Acceso no autorizado. Se requiere token Bearer.' },
    });
  }

  const token = authHeader.slice(7); // quita "Bearer "

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, role: payload.role, name: payload.name };
    next();
  } catch {
    return res.status(401).json({
      success: false,
      error: { message: 'Token inválido o expirado.' },
    });
  }
}
