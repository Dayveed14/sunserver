import { Router } from 'express';
import * as c from '../controllers/interest.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { interestLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { interestSchema } from '../validators/analysis.schemas.js';

// Mounted at /api/interest. Anyone may ask to be told when a category launches; only the admin reads the list.
const router = Router();
router.post('/', interestLimiter, validate(interestSchema), c.add);
router.get('/', authenticate, requireRole('admin'), c.summary);

export default router;
