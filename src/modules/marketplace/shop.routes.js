import { Router } from 'express';
import { HttpError, asyncHandler } from '../../lib/httpError.js';
import { shopLimiter } from '../../middleware/rateLimits.js';
import { shopService as svc } from './index.js';

// The public shop: anyone can browse, but only vendors in the state they pick. Buying needs an account (see orders).
const router = Router();
router.use(shopLimiter);

const id = (req) => {
  if (!/^\d{1,18}$/.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  return Number(req.params.id);
};
const str = (v, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
// Where the shopper wants it delivered: ?state=lagos&areaId=yaba
const destination = (req) => (str(req.query.state) && str(req.query.areaId) ? { state: str(req.query.state), areaId: str(req.query.areaId) } : null);

router.get('/products', asyncHandler(async (req, res) => {
  res.json(await svc.listProducts({ state: str(req.query.state), category: str(req.query.category), q: str(req.query.q) }));
}));
router.get('/deals', asyncHandler(async (req, res) => res.json(await svc.listDeals({ state: str(req.query.state) }))));
router.get('/products/:id', asyncHandler(async (req, res) => res.json(await svc.productPage(id(req), destination(req)))));
router.get('/deals/:id', asyncHandler(async (req, res) => res.json(await svc.dealPage(id(req), destination(req)))));

export default router;
