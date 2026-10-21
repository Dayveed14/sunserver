import { asyncHandler } from '../lib/httpError.js';
import { ordersService as svc } from '../services/index.js';
import { numId, orderRef, queryStatus, queryText } from '../utils/params.js';

export const stats = asyncHandler(async (req, res) => res.json({ stats: await svc.adminStats() }));

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await svc.adminOrders({
    status: queryStatus(q.status),
    state: q.state === 'lagos' || q.state === 'abuja' ? q.state : undefined,
    late: q.late === '1',
    q: queryText(q.q, 40),
  }));
});

export const timeline = asyncHandler(async (req, res) => res.json(await svc.adminTimeline(orderRef(req.params.ref))));
export const markRefunded = asyncHandler(async (req, res) => res.json(await svc.markRefunded(req.user, numId(req.params.id))));
export const act = asyncHandler(async (req, res) => {
  res.json(await svc.adminAct(req.user, numId(req.params.id), req.params.action, req.valid.note ?? null));
});
