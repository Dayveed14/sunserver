import { Router } from 'express';
import { HttpError, asyncHandler } from '../../lib/httpError.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { catalogService as svc } from './index.js';
import { dealSchema, dealStatusSchema, eaasPreviewSchema, productSchema, requestStatusSchema } from './marketplace.schemas.js';

const router = Router();
router.use(authenticate, requireRole('vendor'));

const id = (req) => {
  if (!/^\d{1,18}$/.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  return Number(req.params.id);
};

router.get('/summary', asyncHandler(async (req, res) => res.json(await svc.summary(req.user.id))));

// ---- Products ----
router.get('/products', asyncHandler(async (req, res) => res.json({ products: await svc.listProducts(req.user.id) })));
router.post('/products', validate(productSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ product: await svc.createProduct(req.user.id, req.valid) });
}));
router.put('/products/:id', validate(productSchema), asyncHandler(async (req, res) => {
  res.json({ product: await svc.updateProduct(req.user.id, id(req), req.valid) });
}));
router.delete('/products/:id', asyncHandler(async (req, res) => {
  await svc.archiveProduct(req.user.id, id(req));
  res.status(204).end();
}));

// ---- Deals (combos) ----
router.get('/deals', asyncHandler(async (req, res) => res.json({ deals: await svc.listDeals(req.user.id) })));
router.post('/deals', validate(dealSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ deal: await svc.createDeal(req.user.id, req.valid) });
}));
router.put('/deals/:id', validate(dealSchema), asyncHandler(async (req, res) => {
  res.json({ deal: await svc.updateDeal(req.user.id, id(req), req.valid) });
}));
router.patch('/deals/:id/status', validate(dealStatusSchema), asyncHandler(async (req, res) => {
  res.json({ deal: await svc.setDealStatus(req.user.id, id(req), req.valid.status) });
}));
router.delete('/deals/:id', asyncHandler(async (req, res) => {
  await svc.archiveDeal(req.user.id, id(req));
  res.status(204).end();
}));

// ---- Energy as a service pricing ----
router.get('/eaas-rules', (req, res) => res.json(svc.eaasRules()));
router.post('/eaas-preview', validate(eaasPreviewSchema), asyncHandler(async (req, res) => {
  res.json(await svc.previewEaas(req.user.id, req.valid));
}));

// ---- Requests from customers ----
router.get('/requests', asyncHandler(async (req, res) => res.json({ requests: await svc.listRequests(req.user.id) })));
router.patch('/requests/:id/status', validate(requestStatusSchema), asyncHandler(async (req, res) => {
  await svc.setRequestStatus(req.user.id, id(req), req.valid.status);
  res.status(204).end();
}));

export default router;
