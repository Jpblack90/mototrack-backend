import { Router } from 'express';
import inventoryRoutes from '../modules/inventory/inventory.routes.js';
import workordersRoutes from '../modules/workorders/workorders.routes.js';
import salesRoutes from '../modules/sales/sales.routes.js';
import invoicingRoutes from '../modules/invoicing/invoicing.routes.js';

const router = Router();

router.use('/inventory', inventoryRoutes);
router.use('/workorders', workordersRoutes);
router.use('/sales', salesRoutes);
router.use('/invoicing', invoicingRoutes);

export default router;
