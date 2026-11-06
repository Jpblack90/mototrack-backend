import crypto from 'node:crypto';
import * as workordersService from '../workorders/workorders.service.js';

/**
 * POST /api/jobs/not-picked-up
 *
 * Endpoint para ejecución externa programada (ej: Cloud Scheduler en Cloud Run).
 * Protegido mediante la cabecera 'X-Job-Token' validada en tiempo constante contra process.env.JOBS_TOKEN.
 *
 * - Si JOBS_TOKEN no está definido en el entorno: responde 404 Not Found.
 * - Si falta X-Job-Token o no coincide exactamente: responde 401 Unauthorized.
 * - Si es válido: ejecuta markOverdueNotPickedUp() y responde 200 OK con { success: true, data: result }.
 */
export async function triggerNotPickedUpJob(req, res, next) {
  try {
    const jobsToken = process.env.JOBS_TOKEN;
    if (!jobsToken || jobsToken.trim() === '') {
      return res.status(404).json({
        success: false,
        error: { message: 'Jobs endpoint no configurado.', code: 'NOT_FOUND' },
      });
    }

    const providedToken = req.headers['x-job-token'];
    if (!providedToken) {
      return res.status(401).json({
        success: false,
        error: { message: 'Header X-Job-Token requerido.', code: 'UNAUTHORIZED' },
      });
    }

    const expectedBuffer = Buffer.from(jobsToken);
    const providedBuffer = Buffer.from(String(providedToken));

    const isMatch =
      expectedBuffer.length === providedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, providedBuffer);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: { message: 'Token de job inválido.', code: 'UNAUTHORIZED' },
      });
    }

    const result = await workordersService.markOverdueNotPickedUp();

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
