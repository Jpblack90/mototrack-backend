import { Router } from 'express';
import { triggerNotPickedUpJob } from './jobs.controller.js';

const router = Router();

// POST /api/jobs/not-picked-up (Cloud Scheduler / disparador externo)
router.post('/not-picked-up', triggerNotPickedUpJob);

export default router;
