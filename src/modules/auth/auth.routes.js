import { Router } from 'express';
import {
  loginHandler,
  getMe,
  changePasswordHandler,
  registerCompanyHandler,
} from './auth.controller.js';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import {
  loginRateLimiter,
  loginIpRateLimiter,
  registerCompanyRateLimiter,
  resetAllRateLimiters,
} from '../../shared/middlewares/rateLimiter.js';
import { testHooksEnabled } from '../../shared/utils/testHooks.js';

const router = Router();

router.post('/login', loginIpRateLimiter, loginRateLimiter, loginHandler);
router.post('/register-company', registerCompanyRateLimiter, registerCompanyHandler);
router.get('/me', authenticate, getMe);
router.post('/change-password', authenticate, changePasswordHandler);

// Endpoint de pruebas para reiniciar contadores de rate limiting (solo si test hooks están habilitados)
if (testHooksEnabled()) {
  router.post('/reset-rate-limit', (_req, res) => {
    resetAllRateLimiters();
    res.json({ success: true, message: 'Rate limiters reiniciados correctamente.' });
  });
}

export default router;
