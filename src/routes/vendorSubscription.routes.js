import { Router } from 'express';
import * as c from '../controllers/subscription.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { checkoutLimiter, payVerifyLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { verifySchema } from '../validators/orders.schemas.js';
import { startSubscriptionSchema } from '../validators/subscription.schemas.js';

// Mounted at /api/vendor/subscription: open to every vendor, because a lapsed vendor must be able to pay to come back.
const router = Router();
router.use(authenticate, requireRole('vendor'));

router.get('/', c.status);
router.post('/start', checkoutLimiter, validate(startSubscriptionSchema), c.start);
router.post('/verify', payVerifyLimiter, validate(verifySchema), c.verify);
router.post('/mock-pay', payVerifyLimiter, validate(verifySchema), c.mockPay);

export default router;
