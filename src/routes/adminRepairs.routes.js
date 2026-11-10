import { Router } from 'express';
import * as c from '../controllers/repairs.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { assignTechnicianSchema, repairCancelSchema } from '../validators/repairs.schemas.js';

// Mounted at /api/admin/repairs: the admin approves or changes the recommended technician, cancels stuck repairs and records refunds.
const router = Router();
router.use(authenticate, requireRole('admin'));

router.get('/', c.adminList);
router.get('/:ref', c.adminGet);
router.get('/:ref/photos/:id', c.photo);
router.post('/:ref/approve', c.adminApprove);
router.post('/:ref/decline', c.adminDecline);
router.post('/:ref/assign', validate(assignTechnicianSchema), c.adminAssign);
router.post('/:ref/cancel', validate(repairCancelSchema), c.adminCancel);
router.post('/:ref/refunded', c.adminRefunded);

export default router;
