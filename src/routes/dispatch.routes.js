import { Router } from 'express';
import * as c from '../controllers/dispatch.controller.js';
import { dispatchLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { dispatchSchema } from '../validators/orders.schemas.js';

// Mounted at /api/dispatch: the logistics partner confirms pickup or delivery from an emailed link (no account).
const router = Router();
router.use(dispatchLimiter);

router.get('/info', c.info);
router.post('/confirm', validate(dispatchSchema), c.confirm);

export default router;
