import { Router } from 'express';
import {
  ensurePlatformConfigured,
  authenticatePlatform,
  authenticatePlatformPasswordChange,
} from '../../shared/middlewares/authenticatePlatform.js';
import {
  loginRateLimiter,
  loginIpRateLimiter,
} from '../../shared/middlewares/rateLimiter.js';
import {
  loginHandler,
  changePasswordHandler,
  getMeHandler,
  getMetricsHandler,
  listCompaniesHandler,
  getCompanyDetailHandler,
  resetUserPasswordHandler,
  updateCompanyStatusHandler,
  registerPaymentHandler,
  getAuditHandler,
} from './platform.controller.js';

const router = Router();

// Todas las rutas de plataforma requieren PLATFORM_JWT_SECRET configurado (sino 503)
router.use(ensurePlatformConfigured);

// Autenticación separada de plataforma
router.post('/auth/login', loginIpRateLimiter, loginRateLimiter, loginHandler);
router.post('/auth/change-password', authenticatePlatformPasswordChange, changePasswordHandler);
router.get('/auth/me', authenticatePlatform, getMeHandler);

// Gestión de talleres y auditoría global (requiere haber cambiado la contraseña temporal)
router.get('/metrics', authenticatePlatform, getMetricsHandler);
router.get('/companies', authenticatePlatform, listCompaniesHandler);
router.get('/companies/:id', authenticatePlatform, getCompanyDetailHandler);
router.post('/companies/:id/users/:userId/reset-password', authenticatePlatform, resetUserPasswordHandler);
router.patch('/companies/:id/status', authenticatePlatform, updateCompanyStatusHandler);
router.post('/companies/:id/payments', authenticatePlatform, registerPaymentHandler);
router.get('/audit', authenticatePlatform, getAuditHandler);

export default router;
