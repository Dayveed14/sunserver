import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as c from '../controllers/vendor.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireVendorActive, requireVerifiedVendor } from '../middleware/vendorGate.js';
import { MAX_DOCUMENT_BYTES, DOCUMENT_TYPES } from '../utils/documents.js';
import * as v from '../controllers/verification.controller.js';
import { dealSchema, dealStatusSchema, eaasPreviewSchema, leasePreviewSchema, productSchema, requestStatusSchema } from '../validators/marketplace.schemas.js';

// Mounted at /api/vendor: everything a vendor does with their own catalogue.
const router = Router();
router.use(authenticate, requireRole('vendor'));

// The summary stays open to unpaid vendors; everything below needs an active (or free) registration.
router.get('/summary', c.summary);

// Verification: open to every vendor, because it is how they get approved. Documents are private to the vendor and the admin.
const docLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many uploads. Please wait a few minutes.' } } });
router.get('/verification', v.vendorStatus);
router.post('/documents', docLimiter, express.raw({ type: DOCUMENT_TYPES, limit: MAX_DOCUMENT_BYTES }), v.uploadDocument);
router.get('/documents/:id/file', v.documentFile);
router.delete('/documents/:id', v.deleteDocument);
router.post('/verification/submit', v.submit);

// Everything below needs the registration to be settled and the admin's approval.
router.use(requireVendorActive, requireVerifiedVendor);

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
