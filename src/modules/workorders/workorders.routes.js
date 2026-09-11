import { Router } from 'express';
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

// GET  /api/workorders/placa/:placa    → historial de OT de ese vehículo (RF-14)
router.get('/placa/:placa',       getHistoryByPlaca);

// GET  /api/workorders                 → listar todas (soporta ?status=)
// GET  /api/workorders/:id             → una OT por id
// POST /api/workorders                 → crear OT (crea o reutiliza vehículo por placa)
router.get('/',                   getAllOrders);
router.get('/:id',                getOrder);
router.post('/',                  createOrder);

// PATCH /api/workorders/:id/assign         → asignar mecánico
// PATCH /api/workorders/:id/status         → cambiar estado (máquina de estados)
// PATCH /api/workorders/:id/approve        → UC-03 FA-1: cliente aprueba trabajo adicional
// PATCH /api/workorders/:id/reject         → UC-03 FA-2: cliente rechaza trabajo adicional
// PATCH /api/workorders/:id/not-picked-up  → marcar como no recogido (verificación MANUAL)
router.patch('/:id/assign',       assignMechanic);
router.patch('/:id/status',       updateStatus);
router.patch('/:id/approve',      approveAdditionalWork);
router.patch('/:id/reject',       rejectAdditionalWork);
router.patch('/:id/not-picked-up', markNotPickedUp);

export default router;
