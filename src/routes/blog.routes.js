import { Router } from 'express';
import * as c from '../controllers/blog.controller.js';
import { shopLimiter } from '../middleware/rateLimits.js';

// Mounted at /api/blog: anyone can read published articles.
const router = Router();
router.get('/', shopLimiter, c.list);
router.get('/:slug', shopLimiter, c.get);

export default router;
