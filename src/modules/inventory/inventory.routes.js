import { Router } from 'express';
import {
  getAllItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
} from './inventory.controller.js';

const router = Router();

// GET    /api/inventory          → listar productos activos (soporta ?search=)
// GET    /api/inventory/:id      → obtener un producto por id
// POST   /api/inventory          → crear producto (valida margen; admite force: true)
// PUT    /api/inventory/:id      → actualizar producto (valida margen; admite force: true)
// DELETE /api/inventory/:id      → soft-delete (is_active = false)

router.get('/',     getAllItems);
router.get('/:id',  getItem);
router.post('/',    createItem);
router.put('/:id',  updateItem);
router.delete('/:id', deleteItem);

export default router;
