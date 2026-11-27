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
  getPickupAlerts,
  getOrderNotifications,
  getOrderItems,
  addOrderItem,
  decideOrderItem,
  createOrderItemsNotifyLink,
} from './workorders.controller.js';

const router = Router();

// ⚠️  ORDEN CRÍTICO: /placa/:placa y /pickup-alerts DEBEN declararse ANTES de /:id
//    Si /:id estuviera primero, Express interpretaría "placa" o "pickup-alerts"
//    como un id numérico y nunca llegaría a estas rutas.

// GET  /api/workorders/pickup-alerts   → alertas de motos por recoger (RF-17, admin y cajero)
router.get('/pickup-alerts',       authenticate, authorize('admin', 'cajero'), getPickupAlerts);

// GET  /api/workorders/placa/:placa    → historial de OT de ese vehículo (RF-14)
router.get('/placa/:placa',        authenticate,                               getHistoryByPlaca);

// GET  /api/workorders                 → listar todas (soporta ?status=)
// GET  /api/workorders/:id             → una OT por id
// GET  /api/workorders/:id/notifications → avisos de la OT (admin y cajero, RF-15)
// POST /api/workorders                 → crear OT (crea o reutiliza vehículo por placa)
router.get('/',                    authenticate,                               getAllOrders);
router.get('/:id',                 authenticate,                               getOrder);
router.get('/:id/notifications',   authenticate, authorize('admin', 'cajero'), getOrderNotifications);
router.get('/:id/items',           authenticate, authorize('admin', 'cajero', 'almacenero', 'mecanico'), getOrderItems);
router.post('/',                   authenticate, authorize('admin','cajero'),  createOrder);
router.post('/:id/items',          authenticate, authorize('admin','cajero'),  addOrderItem);
router.post('/:id/items/notify-link', authenticate, authorize('admin','cajero'), createOrderItemsNotifyLink);

// PATCH /api/workorders/:id/assign         → asignar mecánico (admin y cajero, A-02)
// PATCH /api/workorders/:id/status         → cambiar estado (admin, mecánico y cajero, A-03)
// PATCH /api/workorders/:id/approve        → UC-03 FA-1: cliente aprueba trabajo adicional
// PATCH /api/workorders/:id/reject         → UC-03 FA-2: cliente rechaza trabajo adicional
// PATCH /api/workorders/:id/not-picked-up  → marcar como no recogido (admin-only)
// PATCH /api/workorders/:id/items/:itemId/decision → aprobar/rechazar línea (admin y cajero)
router.patch('/:id/assign',        authenticate, authorize('admin','cajero'),              assignMechanic);
router.patch('/:id/status',        authenticate, authorize('admin','mecanico','cajero'),   updateStatus);
router.patch('/:id/approve',       authenticate, authorize('admin','cajero'),              approveAdditionalWork);
router.patch('/:id/reject',        authenticate, authorize('admin','cajero'),              rejectAdditionalWork);
router.patch('/:id/not-picked-up', authenticate, authorize('admin'),                      markNotPickedUp);
router.patch('/:id/items/:itemId/decision', authenticate, authorize('admin','cajero'),     decideOrderItem);

export default router;
