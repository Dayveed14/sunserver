import { Router } from 'express';
import { HttpError, asyncHandler } from '../../lib/httpError.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { requestLimiter } from '../../middleware/rateLimits.js';
import { validate } from '../../middleware/validate.js';
import { offersService as svc } from './index.js';
import { createRequestSchema, diyQuoteSchema } from './marketplace.schemas.js';

const router = Router();
router.use(authenticate, requireRole('individual', 'business'));

const idOf = (value) => {
  if (!/^\d{1,18}$/.test(String(value))) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  return Number(value);
};

// Everything a customer can choose for one saved assessment, for one way of paying.
router.get('/assessments/:id', asyncHandler(async (req, res) => {
  res.json(await svc.getOffers(req.user.id, idOf(req.params.id), String(req.query.plan ?? 'buy'), req.user.role));
}));

// Prices and checks a DIY selection without sending anything to a vendor.
router.post('/assessments/:id/diy-quote', validate(diyQuoteSchema), asyncHandler(async (req, res) => {
  res.json(await svc.quoteDiy(req.user.id, idOf(req.params.id), req.valid.items));
}));

router.post('/assessments/:id/requests', requestLimiter, validate(createRequestSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await svc.createRequests(req.user.id, idOf(req.params.id), req.valid, req.user.role));
}));

router.get('/requests', asyncHandler(async (req, res) => res.json({ requests: await svc.listMine(req.user.id) })));
router.post('/requests/:id/cancel', asyncHandler(async (req, res) => {
  await svc.cancel(req.user.id, idOf(req.params.id));
  res.status(204).end();
}));

export default router;
