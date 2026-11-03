/**
 * Política de contraseñas de MotoTrack AI.
 * Requisitos:
 * - Mínimo 8 caracteres
 * - Al menos una letra (mayúscula o minúscula)
 * - Al menos un número
 *
 * @param {string} password
 * @returns {{ valid: boolean, message?: string }}
 */
export function validatePasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return {
      valid: false,
      message: 'La contraseña debe tener al menos 8 caracteres.',
    };
  }

  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return {
      valid: false,
      message: 'La contraseña debe contener al menos una letra y un número.',
    };
  }

  return { valid: true };
}
