import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize }    from '../../shared/middlewares/authorize.js';
import { getAllUsers, getUser, createUser, updateUser, removeUser } from './users.controller.js';

const router = Router();

// Todas las rutas son admin-only
router.get('/',      authenticate, authorize('admin'), getAllUsers);
router.get('/:id',   authenticate, authorize('admin'), getUser);
router.post('/',     authenticate, authorize('admin'), createUser);
router.patch('/:id', authenticate, authorize('admin'), updateUser);
router.delete('/:id',authenticate, authorize('admin'), removeUser);

export default router;
