import { Router } from 'express';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../lib/httpError.js';
import { shopLimiter } from '../../middleware/rateLimits.js';
import { dealsRepo, productsRepo } from './index.js';
import { publicDeal, publicProduct } from './offers.service.js';
import { dealSpecs, plansOffered } from './matching.js';

// The public shop: anyone can browse what vendors sell. Browse only; buying goes through an assessment.
const router = Router();
router.use(shopLimiter);
const opt = { requireVerified: env.vendorApprovalRequired };
const CATEGORIES = new Set(['panel', 'inverter', 'battery']);

router.get('/products', asyncHandler(async (req, res) => {
  const category = CATEGORIES.has(req.query.category) ? req.query.category : undefined;
  const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  const products = await productsRepo.listPublic({ ...opt, category, search, limit: 100 });
  res.json({ products: products.map(publicProduct) });
}));

router.get('/deals', asyncHandler(async (req, res) => {
  const deals = await dealsRepo.listActive(opt);
  const usable = deals.filter((d) => d.vendorVerification !== 'rejected' && !d.items.some((i) => i.productStatus === 'archived'));
  res.json({
    deals: usable.map((d) => ({ ...publicDeal(d), specs: dealSpecs(d.items), plans: plansOffered(d), buyPrice: d.buyPrice })),
  });
}));

export default router;
