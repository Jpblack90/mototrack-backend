import { Router } from 'express';
import { triggerNotPickedUpJob, triggerSubscriptionsJob } from './jobs.controller.js';

const router = Router();

// POST /api/jobs/not-picked-up (Cloud Scheduler / disparador externo)
router.post('/not-picked-up', triggerNotPickedUpJob);

// POST /api/jobs/subscriptions (Cloud Scheduler / disparador externo)
router.post('/subscriptions', triggerSubscriptionsJob);

export default router;
