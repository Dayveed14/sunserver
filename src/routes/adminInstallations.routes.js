import { Router } from 'express';
import * as c from '../controllers/installations.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { cancelInstallSchema } from '../validators/installations.schemas.js';

// Mounted at /api/admin/installations: the admin watches every job, cancels stuck ones, and records payouts and refunds.
const router = Router();
router.use(authenticate, requireRole('admin'));

router.get('/', c.adminList);
router.get('/:ref', c.adminGet);
router.post('/:ref/cancel', validate(cancelInstallSchema), c.adminCancel);
router.post('/:ref/payout-paid', c.adminPayout);
router.post('/:ref/refunded', c.adminRefunded);

export default router;
