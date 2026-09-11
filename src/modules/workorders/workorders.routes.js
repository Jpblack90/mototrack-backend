import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { authorize }    from '../../shared/middlewares/authorize.js';
import {
  getHistoryByPlaca,
  getAllOrders,
  getOrder,
  createOrder,
  assignMechanic,
  updateStatus,
  approveAdditionalWork,
  rejectAdditionalWork,
  markNotPickedUp,
} from './workorders.controller.js';

const router = Router();

// ⚠️  ORDEN CRÍTICO: /placa/:placa DEBE declararse ANTES de /:id
//    Si /:id estuviera primero, Express interpretaría "placa" como un id numérico
//    y nunca llegaría a esta ruta.

// RETROFIT Fase 6: middlewares de autenticación y autorización por rol
// El orden de las rutas no fue modificado.

// GET  /api/workorders/placa/:placa    → historial de OT de ese vehículo (RF-14)
router.get('/placa/:placa',        authenticate,                               getHistoryByPlaca);

// GET  /api/workorders                 → listar todas (soporta ?status=)
// GET  /api/workorders/:id             → una OT por id
// POST /api/workorders                 → crear OT (crea o reutiliza vehículo por placa)
router.get('/',                    authenticate,                               getAllOrders);
router.get('/:id',                 authenticate,                               getOrder);
router.post('/',                   authenticate, authorize('admin','cajero'),  createOrder);

// PATCH /api/workorders/:id/assign         → asignar mecánico (admin-only)
// PATCH /api/workorders/:id/status         → cambiar estado (admin o mecánico)
// PATCH /api/workorders/:id/approve        → UC-03 FA-1: cliente aprueba trabajo adicional
// PATCH /api/workorders/:id/reject         → UC-03 FA-2: cliente rechaza trabajo adicional
// PATCH /api/workorders/:id/not-picked-up  → marcar como no recogido (admin-only)
router.patch('/:id/assign',        authenticate, authorize('admin'),                      assignMechanic);
router.patch('/:id/status',        authenticate, authorize('admin','mecanico'),            updateStatus);
router.patch('/:id/approve',       authenticate, authorize('admin','cajero'),              approveAdditionalWork);
router.patch('/:id/reject',        authenticate, authorize('admin','cajero'),              rejectAdditionalWork);
router.patch('/:id/not-picked-up', authenticate, authorize('admin'),                      markNotPickedUp);

export default router;
