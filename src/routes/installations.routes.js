import { Router } from 'express';
import * as c from '../controllers/installations.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { checkoutLimiter, orderActionLimiter, payVerifyLimiter, shopLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { createInstallSchema } from '../validators/installations.schemas.js';
import { verifySchema } from '../validators/orders.schemas.js';

// Mounted at /api/installations: a customer asks for an installer, pays, and follows the job.
const router = Router();
router.get('/bands', shopLimiter, c.bands); // the price list is public

router.use(authenticate, requireRole('individual', 'business'));
router.get('/', c.list);
router.post('/', orderActionLimiter, validate(createInstallSchema), c.create);
router.post('/verify', payVerifyLimiter, validate(verifySchema), c.verify);
router.post('/mock-pay', payVerifyLimiter, validate(verifySchema), c.mockPay);
router.get('/:ref', c.get);
router.post('/:ref/pay', checkoutLimiter, c.pay);
router.post('/:ref/cancel', orderActionLimiter, c.cancel);
router.post('/:ref/confirm', orderActionLimiter, c.confirm);

export default router;
