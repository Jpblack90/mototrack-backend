/**
 * Normaliza el nombre de un modelo de motocicleta a solo caracteres alfanuméricos en minúsculas.
 * Ignora mayúsculas, espacios, guiones, puntos y cualquier signo de puntuación.
 * Ejemplo: "Honda CG-125" -> "hondacg125", "HONDA CG.125" -> "hondacg125".
 *
 * @param {string} str
 * @returns {string}
 */
export function normalizeModel(str) {
  if (!str || typeof str !== 'string') return '';
  return str.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
}
