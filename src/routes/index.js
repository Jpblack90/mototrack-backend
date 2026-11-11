import { Router } from 'express';
import authRoutes       from '../modules/auth/auth.routes.js';
import usersRoutes      from '../modules/users/users.routes.js';
import inventoryRoutes  from '../modules/inventory/inventory.routes.js';
import workordersRoutes from '../modules/workorders/workorders.routes.js';
import salesRoutes      from '../modules/sales/sales.routes.js';
import invoicingRoutes  from '../modules/invoicing/invoicing.routes.js';
import dashboardRoutes  from '../modules/dashboard/dashboard.routes.js';
import companyRoutes    from '../modules/company/company.routes.js';
import auditRoutes      from '../modules/audit/audit.routes.js';
import jobsRoutes       from '../modules/jobs/jobs.routes.js';
import notificationsRoutes from '../modules/notifications/notifications.routes.js';
import platformRoutes   from '../modules/platform/platform.routes.js';

const router = Router();

router.use('/auth',          authRoutes);
router.use('/users',         usersRoutes);
router.use('/inventory',     inventoryRoutes);
router.use('/workorders',    workordersRoutes);
router.use('/sales',         salesRoutes);
router.use('/invoicing',     invoicingRoutes);
router.use('/dashboard',     dashboardRoutes);
router.use('/company',       companyRoutes);
router.use('/audit',         auditRoutes);
router.use('/jobs',          jobsRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/platform',      platformRoutes);

export default router;
