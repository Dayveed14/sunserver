import { Router } from 'express';
import * as c from '../controllers/vendor.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireVendorActive } from '../middleware/vendorGate.js';
import { dealSchema, dealStatusSchema, eaasPreviewSchema, leasePreviewSchema, productSchema, requestStatusSchema } from '../validators/marketplace.schemas.js';

// Mounted at /api/vendor: everything a vendor does with their own catalogue.
const router = Router();
router.use(authenticate, requireRole('vendor'));

// The summary stays open to unpaid vendors; everything below needs an active (or free) registration.
router.get('/summary', c.summary);
router.use(requireVendorActive);

router.get('/products', c.listProducts);
router.post('/products', validate(productSchema), c.createProduct);
router.put('/products/:id', validate(productSchema), c.updateProduct);
router.delete('/products/:id', c.archiveProduct);

router.get('/deals', c.listDeals);
router.post('/deals', validate(dealSchema), c.createDeal);
router.put('/deals/:id', validate(dealSchema), c.updateDeal);
router.patch('/deals/:id/status', validate(dealStatusSchema), c.setDealStatus);
router.delete('/deals/:id', c.archiveDeal);

router.post('/lease-preview', validate(leasePreviewSchema), c.leasePreview);
router.get('/eaas-rules', c.eaasRules);
router.post('/eaas-preview', validate(eaasPreviewSchema), c.eaasPreview);

router.get('/requests', c.listRequests);
router.patch('/requests/:id/status', validate(requestStatusSchema), c.setRequestStatus);

export default router;
