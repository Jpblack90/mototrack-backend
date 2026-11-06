/**
 * Normaliza un número telefónico al formato internacional de celular peruano para WhatsApp (519XXXXXXXX).
 *
 * Reglas (RF-15):
 * - Quita todo lo que no sea dígito.
 * - 9 dígitos que empiezan con 9 (/^9\d{8}$/) → '51' + número.
 * - 11 dígitos que empiezan con '519' (/^519\d{8}$/) → número tal cual.
 * - Cualquier otro caso (fijos, longitud incorrecta, valores nulos/vacíos) → null.
 *
 * @param {string|number|null|undefined} raw
 * @returns {string|null} Celular en formato '519XXXXXXXX' o null si no es un celular peruano válido.
 */
export function normalizePhonePE(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (/^9\d{8}$/.test(digits)) {
    return '51' + digits;
  }
  if (/^519\d{8}$/.test(digits)) {
    return digits;
  }
  return null;
}
