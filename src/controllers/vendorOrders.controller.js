import { asyncHandler } from '../lib/httpError.js';
import { ordersService as svc } from '../services/index.js';
import { numId, queryStatus } from '../utils/params.js';

export const list = asyncHandler(async (req, res) => res.json(await svc.vendorOrders(req.user.id, { status: queryStatus(req.query.status) })));

// accept, reject, start preparing, ready for pickup ... (which actions are allowed is decided in the service)
export const act = asyncHandler(async (req, res) => {
  res.json(await svc.vendorAct(req.user, numId(req.params.id), req.params.action, req.valid.note ?? null));
});
