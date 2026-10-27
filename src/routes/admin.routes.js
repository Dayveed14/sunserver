import { Router } from 'express';
import * as c from '../controllers/admin.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as v from '../controllers/verification.controller.js';
import { decisionSchema } from '../validators/verification.schemas.js';
import { productSchema } from '../validators/marketplace.schemas.js';
import { settingsSchema, userStatusSchema, vendorStatusSchema } from '../validators/admin.schemas.js';

// Mounted at /api/admin: everything only the admin may do.
const router = Router();
router.use(authenticate, requireRole('admin'));

router.get('/summary', c.summary);

router.get('/vendors', c.listVendors);
router.get('/vendors/:id/review', v.vendorReview);
router.patch('/vendors/:id/verification', validate(vendorStatusSchema), v.decideVendor);
router.get('/documents/:id/file', v.documentFile);

router.get('/installers', v.listInstallers);
router.get('/installers/:id', v.installerReview);
router.patch('/installers/:id/verification', validate(decisionSchema), v.decideInstaller);

router.get('/users', c.listUsers);
router.patch('/users/:id/status', validate(userStatusSchema), c.setUserStatus);

router.get('/products', c.listProducts);
router.put('/products/:id', validate(productSchema), c.updateProduct);
router.delete('/products/:id', c.archiveProduct);

router.get('/settings', c.listSettings);
router.put('/settings', validate(settingsSchema), c.saveSettings);

router.get('/audit', c.audit);

export default router;
