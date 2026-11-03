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
} from '../../shared/middlewares/rateLimiter.js';

const router = Router();

router.post('/login', loginIpRateLimiter, loginRateLimiter, loginHandler);
router.post('/register-company', registerCompanyRateLimiter, registerCompanyHandler);
router.get('/me', authenticate, getMe);
router.post('/change-password', authenticate, changePasswordHandler);

export default router;
