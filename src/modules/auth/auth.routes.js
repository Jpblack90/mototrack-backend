import { Router } from 'express';
import { loginHandler, getMe, changePasswordHandler } from './auth.controller.js';
import { authenticate } from '../../shared/middlewares/authenticate.js';

const router = Router();

router.post('/login', loginHandler);
router.get('/me', authenticate, getMe);
router.post('/change-password', authenticate, changePasswordHandler);

export default router;
