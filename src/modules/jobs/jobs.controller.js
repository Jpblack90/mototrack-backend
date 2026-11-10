import crypto from 'node:crypto';
import * as workordersService from '../workorders/workorders.service.js';
import { markOverdueSubscriptions } from '../company/subscription.service.js';

function validateJobToken(req, res) {
  const jobsToken = process.env.JOBS_TOKEN;
  if (!jobsToken || jobsToken.trim() === '') {
    res.status(404).json({
      success: false,
      error: { message: 'Jobs endpoint no configurado.', code: 'NOT_FOUND' },
    });
    return false;
  }

  const providedToken = req.headers['x-job-token'];
  if (!providedToken) {
    res.status(401).json({
      success: false,
      error: { message: 'Header X-Job-Token requerido.', code: 'UNAUTHORIZED' },
    });
    return false;
  }

  const expectedBuffer = Buffer.from(jobsToken);
  const providedBuffer = Buffer.from(String(providedToken));

  const isMatch =
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);

  if (!isMatch) {
    res.status(401).json({
      success: false,
      error: { message: 'Token de job inválido.', code: 'UNAUTHORIZED' },
    });
    return false;
  }

  return true;
}

/**
 * POST /api/jobs/not-picked-up
 *
 * Endpoint para ejecución externa programada (ej: Cloud Scheduler en Cloud Run).
 * Protegido mediante la cabecera 'X-Job-Token' validada en tiempo constante contra process.env.JOBS_TOKEN.
 */
export async function triggerNotPickedUpJob(req, res, next) {
  try {
    if (!validateJobToken(req, res)) return;

    const result = await workordersService.markOverdueNotPickedUp();

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/jobs/subscriptions
 *
 * Endpoint para ejecución externa programada del job de suspensión de suscripciones vencidas.
 * Protegido mediante la cabecera 'X-Job-Token' validada en tiempo constante contra process.env.JOBS_TOKEN.
 */
export async function triggerSubscriptionsJob(req, res, next) {
  try {
    if (!validateJobToken(req, res)) return;

    const result = await markOverdueSubscriptions();

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

