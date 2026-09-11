import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { loginHandler, getMe } from './auth.controller.js';

const router = Router();

// POST /api/auth/login  → público, sin middleware de autenticación
router.post('/login', loginHandler);

// GET  /api/auth/me     → requiere token válido
router.get('/me', authenticate, getMe);

export default router;
