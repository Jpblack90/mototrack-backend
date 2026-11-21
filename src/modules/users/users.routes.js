import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize }    from '../../shared/middlewares/authorize.js';
import {
  getAllUsers,
  getUser,
  createUser,
  updateUser,
  removeUser,
  resetUserPassword,
  getMechanics,
} from './users.controller.js';

const router = Router();

// GET /api/users/mechanics — mecánicos activos de la empresa (admin y cajero, A-02)
// DEBE ir antes de /:id para evitar que Express interprete "mechanics" como un id
router.get('/mechanics',           authenticate, authorize('admin','cajero'),  getMechanics);

// Resto de rutas admin-only
router.get('/',                    authenticate, authorize('admin'), getAllUsers);
router.get('/:id',                 authenticate, authorize('admin'), getUser);
router.post('/',                   authenticate, authorize('admin'), createUser);
router.patch('/:id',               authenticate, authorize('admin'), updateUser);
router.delete('/:id',              authenticate, authorize('admin'), removeUser);
router.post('/:id/reset-password', authenticate, authorize('admin'), resetUserPassword);

export default router;
