/**
 * Middleware de autorización por rol (RBAC).
 *
 * Uso: authorize('admin', 'cajero')  o  authorize(['admin'])
 * Debe ejecutarse DESPUÉS de authenticate (req.user ya debe existir).
 *
 * @param {...string} allowedRoles  Roles permitidos para la ruta
 * @returns {Function} Middleware Express
 */
export function authorize(...allowedRoles) {
  // Permite pasar un array o argumentos individuales
  const roles = allowedRoles.flat();

  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: {
          message: `Acceso denegado. Se requiere rol: ${roles.join(' o ')}.`,
        },
      });
    }
    next();
  };
}
