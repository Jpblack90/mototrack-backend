/**
 * Helper de seguridad para verificar si los hooks y endpoints exclusivos de prueba están habilitados.
 *
 * REGLA DE SEGURIDAD:
 * En producción o cuando no se define explícitamente ENABLE_TEST_HOOKS=1,
 * todas las trampas de prueba permanecen completamente APAGADAS por defecto.
 *
 * @returns {boolean} true solo si ENABLE_TEST_HOOKS === '1' y NODE_ENV !== 'production'
 */
export function testHooksEnabled() {
  return process.env.ENABLE_TEST_HOOKS === '1' && process.env.NODE_ENV !== 'production';
}
