import { Router } from 'express';
import * as c from '../controllers/offers.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { requestLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { createRequestSchema, diyQuoteSchema } from '../validators/marketplace.schemas.js';

// Mounted at /api/offers: what a customer can buy for a saved assessment, and quote requests to vendors.
const router = Router();
router.use(authenticate, requireRole('individual', 'business'));

router.get('/assessments/:id', c.getOffers);
router.post('/assessments/:id/diy-quote', validate(diyQuoteSchema), c.diyQuote);
router.post('/assessments/:id/requests', requestLimiter, validate(createRequestSchema), c.createRequests);

router.get('/requests', c.listMyRequests);
router.post('/requests/:id/cancel', c.cancelRequest);

export default router;
