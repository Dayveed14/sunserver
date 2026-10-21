import { Router } from 'express';
import { asyncHandler } from '../../lib/httpError.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { checkoutLimiter, payVerifyLimiter } from '../../middleware/rateLimits.js';
import { validate } from '../../middleware/validate.js';
import { verifySchema } from '../orders/orders.schemas.js';
import { registrationFee as svc } from './index.js';

// The vendor's one-time registration payment. Dormant while registration is free (config/launch.js).
const router = Router();
router.use(authenticate, requireRole('vendor'));
router.get('/', asyncHandler(async (req, res) => res.json(await svc.status(req.user.id))));
router.post('/start', checkoutLimiter, asyncHandler(async (req, res) => res.status(201).json(await svc.start(req.user))));
router.post('/verify', payVerifyLimiter, validate(verifySchema), asyncHandler(async (req, res) => res.json(await svc.verifyAndSettle(req.user, req.valid.reference))));
router.post('/mock-pay', payVerifyLimiter, validate(verifySchema), asyncHandler(async (req, res) => res.json(await svc.mockPay(req.user, req.valid.reference))));
export default router;
