import { Router } from 'express';
import * as c from '../controllers/partners.controller.js';
import { shopLimiter } from '../middleware/rateLimits.js';

// Mounted at /api/partners: anyone can see who is on the platform (verified, paid-up vendors and approved installers).
const router = Router();
router.get('/', shopLimiter, c.list);

export default router;
