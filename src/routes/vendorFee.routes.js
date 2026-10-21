import { Router } from 'express';
import * as c from '../controllers/vendorFee.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { checkoutLimiter, payVerifyLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { verifySchema } from '../validators/orders.schemas.js';

// Mounted at /api/vendor/fee: the vendor's one-time registration payment (dormant while it is free).
const router = Router();
router.use(authenticate, requireRole('vendor'));

router.get('/', c.status);
router.post('/start', checkoutLimiter, c.start);
router.post('/verify', payVerifyLimiter, validate(verifySchema), c.verify);
router.post('/mock-pay', payVerifyLimiter, validate(verifySchema), c.mockPay);

export default router;
