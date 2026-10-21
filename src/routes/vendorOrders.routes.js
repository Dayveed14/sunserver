import { Router } from 'express';
import * as c from '../controllers/vendorOrders.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { orderActionLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { requireVendorActive } from '../middleware/vendorGate.js';
import { noteSchema } from '../validators/orders.schemas.js';

// Mounted at /api/vendor/orders: the vendor's incoming orders and the steps they press.
const router = Router();
router.use(authenticate, requireRole('vendor'), requireVendorActive);

router.get('/', c.list);
router.post('/:id/:action', orderActionLimiter, validate(noteSchema), c.act);

export default router;
