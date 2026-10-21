import { Router } from 'express';
import * as c from '../controllers/orders.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { checkoutLimiter, orderActionLimiter, payVerifyLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { cartSchema, verifySchema } from '../validators/orders.schemas.js';

// Mounted at /api: the customer's checkout and orders.
// The sign-in check is scoped to these two paths so it never blocks /api/shop or /api/offers.
const router = Router();
router.use(['/checkout', '/orders'], authenticate, requireRole('individual', 'business'));

router.post('/checkout/quote', orderActionLimiter, validate(cartSchema), c.quote);
router.post('/checkout', checkoutLimiter, validate(cartSchema), c.checkout);
router.post('/checkout/:ref/pay', checkoutLimiter, c.retryPayment);
router.post('/checkout/verify', payVerifyLimiter, validate(verifySchema), c.verifyPayment);
router.post('/checkout/mock-pay', payVerifyLimiter, validate(verifySchema), c.mockPay);

router.get('/orders', c.myOrders);
router.get('/orders/:ref', c.myOrder);
router.post('/orders/:ref/received/:voId', orderActionLimiter, c.confirmReceived);

export default router;
