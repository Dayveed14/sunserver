import { asyncHandler } from '../lib/httpError.js';
import { catalogService, registrationFeeService } from '../services/index.js';
import { numId } from '../utils/params.js';

// The summary stays open to unpaid vendors: it tells the dashboard whether to show the "pay to start" screen.
export const summary = asyncHandler(async (req, res) => {
  res.json({ ...(await catalogService.summary(req.user.id)), registrationFee: await registrationFeeService.status(req.user.id) });
});

// ---- Products ----
export const listProducts = asyncHandler(async (req, res) => res.json({ products: await catalogService.listProducts(req.user.id) }));
export const createProduct = asyncHandler(async (req, res) => res.status(201).json({ product: await catalogService.createProduct(req.user.id, req.valid) }));
export const updateProduct = asyncHandler(async (req, res) => res.json({ product: await catalogService.updateProduct(req.user.id, numId(req.params.id), req.valid) }));
export const archiveProduct = asyncHandler(async (req, res) => {
  await catalogService.archiveProduct(req.user.id, numId(req.params.id));
  res.status(204).end();
});

// ---- Deals (combos) ----
export const listDeals = asyncHandler(async (req, res) => res.json({ deals: await catalogService.listDeals(req.user.id) }));
export const createDeal = asyncHandler(async (req, res) => res.status(201).json({ deal: await catalogService.createDeal(req.user.id, req.valid) }));
export const updateDeal = asyncHandler(async (req, res) => res.json({ deal: await catalogService.updateDeal(req.user.id, numId(req.params.id), req.valid) }));
export const setDealStatus = asyncHandler(async (req, res) => {
  res.json({ deal: await catalogService.setDealStatus(req.user.id, numId(req.params.id), req.valid.status) });
});
export const archiveDeal = asyncHandler(async (req, res) => {
  await catalogService.archiveDeal(req.user.id, numId(req.params.id));
  res.status(204).end();
});

// ---- Lease and energy-as-a-service pricing ----
export const leasePreview = (req, res) => res.json(catalogService.leasePreview(req.valid));
export const eaasRules = (req, res) => res.json(catalogService.eaasRules());
export const eaasPreview = asyncHandler(async (req, res) => res.json(await catalogService.previewEaas(req.user.id, req.valid)));

// ---- Requests from customers ----
export const listRequests = asyncHandler(async (req, res) => res.json({ requests: await catalogService.listRequests(req.user.id) }));
export const setRequestStatus = asyncHandler(async (req, res) => {
  await catalogService.setRequestStatus(req.user.id, numId(req.params.id), req.valid.status);
  res.status(204).end();
});
