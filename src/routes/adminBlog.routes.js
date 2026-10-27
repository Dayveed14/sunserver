import { Router } from 'express';
import * as c from '../controllers/blog.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { articleSchema } from '../validators/blog.schemas.js';

// Mounted at /api/admin/blog: the admin writes and publishes articles.
const router = Router();
router.use(authenticate, requireRole('admin'));

router.get('/', c.adminList);
router.post('/', validate(articleSchema), c.adminCreate);
router.get('/:id', c.adminGet);
router.put('/:id', validate(articleSchema), c.adminUpdate);
router.delete('/:id', c.adminDelete);

export default router;
