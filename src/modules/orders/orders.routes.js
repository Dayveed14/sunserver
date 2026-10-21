import { Router } from 'express';
import { HttpError, asyncHandler } from '../../lib/httpError.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { checkoutLimiter, dispatchLimiter, orderActionLimiter, payVerifyLimiter } from '../../middleware/rateLimits.js';
import { validate } from '../../middleware/validate.js';
import { requireVendorActive } from '../../middleware/vendorGate.js';
import { dispatchTokens, ordersService as svc } from './index.js';
import { cartSchema, dispatchSchema, noteSchema, verifySchema } from './orders.schemas.js';

const numId = (v) => {
  if (!/^\d{1,18}$/.test(String(v))) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  return Number(v);
};
const refParam = (v) => {
  if (!/^SL-[A-Z0-9]{8}$/.test(String(v))) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
  return String(v);
};

// Where an order goes: what the customer typed, or else the address saved on their account.
const destinationOf = (user, d) => {
  if (d) return { name: d.name ?? user.fullName, phone: d.phone ?? user.phone, line: d.line, state: d.state, areaId: d.areaId };
  if (!user.address?.line) throw new HttpError(400, 'VALIDATION_ERROR', 'Add a delivery address to your profile or choose another location.');
  return { name: user.fullName, phone: user.phone, line: user.address.line, state: user.address.state, areaId: user.address.areaId };
};

// ---------- customer: quote, pay, track ----------
export const customerRouter = Router();
customerRouter.use(['/checkout', '/orders'], authenticate, requireRole('individual', 'business'));

customerRouter.post('/checkout/quote', orderActionLimiter, validate(cartSchema), asyncHandler(async (req, res) => {
  const q = await svc.quote(req.user, { items: req.valid.items, destination: destinationOf(req.user, req.valid.destination) });
  res.json({ quote: svc.publicQuote(q) });
}));

customerRouter.post('/checkout', checkoutLimiter, validate(cartSchema), asyncHandler(async (req, res) => {
  const out = await svc.checkout(req.user, {
    items: req.valid.items,
    destination: destinationOf(req.user, req.valid.destination),
    idempotencyKey: req.get('idempotency-key'),
  });
  res.status(out.alreadyPaid ? 200 : 201).json(out);
}));

customerRouter.post('/checkout/:ref/pay', checkoutLimiter, asyncHandler(async (req, res) => {
  res.json(await svc.retryPayment(req.user, refParam(req.params.ref)));
}));

// The browser returns from Paystack. We ask Paystack, not the browser, whether it was paid.
customerRouter.post('/checkout/verify', payVerifyLimiter, validate(verifySchema), asyncHandler(async (req, res) => {
  res.json(await svc.verifyAndSettle(req.user, req.valid.reference));
}));
customerRouter.post('/checkout/mock-pay', payVerifyLimiter, validate(verifySchema), asyncHandler(async (req, res) => {
  res.json(await svc.mockPay(req.user, req.valid.reference));
}));

customerRouter.get('/orders', asyncHandler(async (req, res) => res.json(await svc.myOrders(req.user))));
customerRouter.get('/orders/:ref', asyncHandler(async (req, res) => res.json(await svc.myOrder(req.user, refParam(req.params.ref)))));
customerRouter.post('/orders/:ref/received/:voId', orderActionLimiter, asyncHandler(async (req, res) => {
  res.json(await svc.confirmReceived(req.user, refParam(req.params.ref), numId(req.params.voId)));
}));

// ---------- vendor ----------
export const vendorOrdersRouter = Router();
vendorOrdersRouter.use(authenticate, requireRole('vendor'), requireVendorActive);
vendorOrdersRouter.get('/', asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' && /^[a-z_]{3,20}$/.test(req.query.status) ? req.query.status : undefined;
  res.json(await svc.vendorOrders(req.user.id, { status }));
}));
vendorOrdersRouter.post('/:id/:action', orderActionLimiter, validate(noteSchema), asyncHandler(async (req, res) => {
  res.json(await svc.vendorAct(req.user, numId(req.params.id), req.params.action, req.valid.note ?? null));
}));

// ---------- admin ----------
export const adminOrdersRouter = Router();
adminOrdersRouter.use(authenticate, requireRole('admin'));
adminOrdersRouter.get('/stats', asyncHandler(async (req, res) => res.json({ stats: await svc.adminStats() })));
adminOrdersRouter.get('/', asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await svc.adminOrders({
    status: typeof q.status === 'string' && /^[a-z_]{3,20}$/.test(q.status) ? q.status : undefined,
    state: q.state === 'lagos' || q.state === 'abuja' ? q.state : undefined,
    late: q.late === '1',
    q: typeof q.q === 'string' ? q.q.trim().slice(0, 40) : undefined,
  }));
}));
adminOrdersRouter.get('/ref/:ref/events', asyncHandler(async (req, res) => res.json(await svc.adminTimeline(refParam(req.params.ref)))));
adminOrdersRouter.post('/:id/refunded', orderActionLimiter, asyncHandler(async (req, res) => res.json(await svc.markRefunded(req.user, numId(req.params.id)))));
adminOrdersRouter.post('/:id/:action', orderActionLimiter, validate(noteSchema), asyncHandler(async (req, res) => {
  res.json(await svc.adminAct(req.user, numId(req.params.id), req.params.action, req.valid.note ?? null));
}));

// ---------- logistics partner (no account; a signed link per order) ----------
export const dispatchRouter = Router();
dispatchRouter.use(dispatchLimiter);
const parseToken = (t) => {
  const parsed = dispatchTokens.verify(t);
  if (!parsed) throw new HttpError(404, 'NOT_FOUND', 'This link is not valid.');
  return parsed;
};
dispatchRouter.get('/info', asyncHandler(async (req, res) => {
  res.json({ job: await svc.dispatchInfo(parseToken(typeof req.query.t === 'string' ? req.query.t : '')) });
}));
dispatchRouter.post('/confirm', validate(dispatchSchema), asyncHandler(async (req, res) => {
  res.json(await svc.dispatchConfirm(parseToken(req.valid.t)));
}));
