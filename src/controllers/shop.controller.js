import { asyncHandler } from '../lib/httpError.js';
import { shopService } from '../services/index.js';
import { numId, queryText } from '../utils/params.js';

// Where the shopper wants it delivered: ?state=lagos&areaId=yaba
const destination = (req) => {
  const state = queryText(req.query.state);
  const areaId = queryText(req.query.areaId);
  return state && areaId ? { state, areaId } : null;
};

export const listProducts = asyncHandler(async (req, res) => {
  res.json(await shopService.listProducts({ state: queryText(req.query.state), category: queryText(req.query.category), q: queryText(req.query.q) }));
});
export const listDeals = asyncHandler(async (req, res) => res.json(await shopService.listDeals({ state: queryText(req.query.state) })));
export const productPage = asyncHandler(async (req, res) => res.json(await shopService.productPage(numId(req.params.id), destination(req))));
export const dealPage = asyncHandler(async (req, res) => res.json(await shopService.dealPage(numId(req.params.id), destination(req))));
