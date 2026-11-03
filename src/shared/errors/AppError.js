/**
 * Error de aplicación personalizado para el backend de MotoTrack AI.
 * Permite definir mensaje descriptivo, código de error funcional y código de estado HTTP.
 */
export class AppError extends Error {
  /**
   * @param {string} message               Mensaje explicativo para el cliente o logs
   * @param {string|number} codeOrStatus   Código funcional (ej: 'INVALID_FIELD') o código HTTP (ej: 422)
   * @param {number|string} [statusOrCode] Código de estado HTTP o código funcional
   */
  constructor(message, codeOrStatus = 'ERROR', statusOrCode = 400) {
    super(message);
    this.name = 'AppError';

    if (typeof codeOrStatus === 'number') {
      this.statusCode = codeOrStatus;
      this.status = codeOrStatus;
      this.code = typeof statusOrCode === 'string' ? statusOrCode : 'ERROR';
    } else {
      this.code = codeOrStatus;
      this.statusCode = typeof statusOrCode === 'number' ? statusOrCode : 400;
      this.status = this.statusCode;
    }
  }
}
