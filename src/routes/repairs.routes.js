import express, { Router } from 'express';
import * as c from '../controllers/repairs.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { checkoutLimiter, orderActionLimiter, payVerifyLimiter, shopLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { createRepairSchema } from '../validators/repairs.schemas.js';
import { verifySchema } from '../validators/orders.schemas.js';
import { MAX_IMAGE_BYTES } from '../utils/images.js';

// Mounted at /api/repairs: a customer reports a fault, pays the call-out fee and follows the repair.
const router = Router();
router.get('/options', shopLimiter, c.options); // fault types, equipment and the call-out price list are public

router.use(authenticate, requireRole('individual', 'business'));
router.get('/', c.list);
router.post('/', orderActionLimiter, validate(createRepairSchema), c.create);
router.post('/verify', payVerifyLimiter, validate(verifySchema), c.verify);
router.post('/mock-pay', payVerifyLimiter, validate(verifySchema), c.mockPay);
router.get('/:ref', c.get);
router.post('/:ref/photos', orderActionLimiter, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES }), c.addPhoto);
router.delete('/:ref/photos/:id', orderActionLimiter, c.removePhoto);
router.get('/:ref/photos/:id', c.photo);
router.post('/:ref/pay', checkoutLimiter, c.pay);
router.post('/:ref/cancel', orderActionLimiter, c.cancel);

export default router;
