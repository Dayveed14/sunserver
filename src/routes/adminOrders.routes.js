import { Router } from 'express';
import * as c from '../controllers/adminOrders.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { orderActionLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { noteSchema } from '../validators/orders.schemas.js';

// Mounted at /api/admin/orders: the admin's view of every order.
const router = Router();
router.use(authenticate, requireRole('admin'));

router.get('/stats', c.stats);
router.get('/', c.list);
router.get('/ref/:ref/events', c.timeline);
router.post('/:id/refunded', orderActionLimiter, c.markRefunded);
router.post('/:id/:action', orderActionLimiter, validate(noteSchema), c.act);

export default router;
