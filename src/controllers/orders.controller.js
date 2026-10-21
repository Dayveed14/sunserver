import { HttpError, asyncHandler } from '../lib/httpError.js';
import { ordersService as svc } from '../services/index.js';
import { numId, orderRef } from '../utils/params.js';

// Where an order goes: what the customer typed, or else the address saved on their account.
const destinationOf = (user, d) => {
  if (d) return { name: d.name ?? user.fullName, phone: d.phone ?? user.phone, line: d.line, state: d.state, areaId: d.areaId };
  if (!user.address?.line) throw new HttpError(400, 'VALIDATION_ERROR', 'Add a delivery address to your profile or choose another location.');
  return { name: user.fullName, phone: user.phone, line: user.address.line, state: user.address.state, areaId: user.address.areaId };
};

// ---------- customer: quote, pay, track ----------
export const quote = asyncHandler(async (req, res) => {
  const q = await svc.quote(req.user, { items: req.valid.items, destination: destinationOf(req.user, req.valid.destination) });
  res.json({ quote: svc.publicQuote(q) });
});

export const checkout = asyncHandler(async (req, res) => {
  const out = await svc.checkout(req.user, {
    items: req.valid.items,
    destination: destinationOf(req.user, req.valid.destination),
    idempotencyKey: req.get('idempotency-key'),
  });
  res.status(out.alreadyPaid ? 200 : 201).json(out);
});

export const retryPayment = asyncHandler(async (req, res) => res.json(await svc.retryPayment(req.user, orderRef(req.params.ref))));

// The browser returns from Paystack. We ask Paystack, not the browser, whether it was paid.
export const verifyPayment = asyncHandler(async (req, res) => res.json(await svc.verifyAndSettle(req.user, req.valid.reference)));
export const mockPay = asyncHandler(async (req, res) => res.json(await svc.mockPay(req.user, req.valid.reference)));

export const myOrders = asyncHandler(async (req, res) => res.json(await svc.myOrders(req.user)));
export const myOrder = asyncHandler(async (req, res) => res.json(await svc.myOrder(req.user, orderRef(req.params.ref))));
export const confirmReceived = asyncHandler(async (req, res) => {
  res.json(await svc.confirmReceived(req.user, orderRef(req.params.ref), numId(req.params.voId)));
});
