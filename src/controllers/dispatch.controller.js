import { HttpError, asyncHandler } from '../lib/httpError.js';
import { dispatchTokens, ordersService as svc } from '../services/index.js';

// Logistics partner: no account, a signed link per order.
const parseToken = (t) => {
  const parsed = dispatchTokens.verify(t);
  if (!parsed) throw new HttpError(404, 'NOT_FOUND', 'This link is not valid.');
  return parsed;
};

export const info = asyncHandler(async (req, res) => {
  res.json({ job: await svc.dispatchInfo(parseToken(typeof req.query.t === 'string' ? req.query.t : '')) });
});
export const confirm = asyncHandler(async (req, res) => res.json(await svc.dispatchConfirm(parseToken(req.valid.t))));
