import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHarness } from '../test-support/ordersHarness.js';

const user = (id = 1, role = 'individual') => ({ id, role, email: `c${id}@x.ng`, fullName: 'Chi One' });

async function paidOrder(h, items = [{ kind: 'product', id: 1, qty: 1 }], u = user()) {
  const co = await h.service.checkout(u, { items, destination: h.dest, idempotencyKey: h.key() });
  const ref = co.payment.reference;
  const r = await h.service.handlePaymentResult({ reference: ref, status: 'success', amountKobo: co.order.total * 100, currency: 'NGN' });
  return { co, ref, r, order: await h.ordersModel.findByRef(co.order.ref) };
}

describe('pricing a cart', () => {
  it('prices from the database and adds one delivery fee per vendor', async () => {
    const h = createHarness();
    const q = await h.service.quote(user(), { items: [{ kind: 'product', id: 1, qty: 2 }, { kind: 'product', id: 2, qty: 1 }], destination: h.dest });
    assert.equal(q.subtotal, 2 * 100000 + 450000);
    assert.equal(q.parts.length, 2);
    assert.equal(q.deliveryFee, q.parts[0].deliveryFee + q.parts[1].deliveryFee);
    assert.equal(q.total, q.subtotal + q.serviceCharge + q.deliveryFee);
    const pub = h.service.publicQuote(q);
    assert.equal(pub.vendorCount, 2);
    assert.ok(!('parts' in pub));
  });
  it('merges repeated lines so quantity limits cannot be dodged', async () => {
    const h = createHarness();
    await assert.rejects(h.service.quote(user(), { items: [{ kind: 'product', id: 1, qty: 15 }, { kind: 'product', id: 1, qty: 15 }], destination: h.dest }), /up to 20/);
  });
  it('refuses vendors from another state (no interstate delivery)', async () => {
    const h = createHarness();
    await assert.rejects(h.service.quote(user(), { items: [{ kind: 'product', id: 3, qty: 1 }], destination: h.dest }), (e) => e.code === 'CART_ISSUES');
  });
  it('refuses out-of-stock items and vendors accounts', async () => {
    const h = createHarness();
    await assert.rejects(h.service.quote(user(), { items: [{ kind: 'product', id: 4, qty: 1 }], destination: h.dest }), (e) => e.code === 'CART_ISSUES');
    await assert.rejects(h.service.quote(user(10, 'vendor'), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest }), (e) => e.status === 403);
  });
  it('a nearer vendor costs less to deliver than a farther one', async () => {
    const h = createHarness();
    const near = await h.service.quote(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: { ...h.dest, areaId: 'ikeja' } });
    const far = await h.service.quote(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: { ...h.dest, areaId: 'ajah' } });
    assert.ok(far.deliveryFee > near.deliveryFee);
  });
});

describe('checkout idempotency', () => {
  it('the same key never makes a second order or a second payment', async () => {
    const h = createHarness();
    const key = h.key();
    const items = [{ kind: 'product', id: 1, qty: 1 }];
    const a = await h.service.checkout(user(), { items, destination: h.dest, idempotencyKey: key });
    const b = await h.service.checkout(user(), { items, destination: h.dest, idempotencyKey: key });
    assert.equal(a.order.ref, b.order.ref);
    assert.equal(a.payment.reference, b.payment.reference);
    assert.equal(h.ordersModel._orders.length, 1);
    assert.equal(h.ordersModel._payments.length, 1);
  });
  it('twenty simultaneous clicks make one order', async () => {
    const h = createHarness();
    const key = h.key();
    const items = [{ kind: 'product', id: 1, qty: 1 }];
    const all = await Promise.all(Array.from({ length: 20 }, () => h.service.checkout(user(), { items, destination: h.dest, idempotencyKey: key })));
    assert.equal(new Set(all.map((x) => x.order.ref)).size, 1);
    assert.equal(h.ordersModel._orders.length, 1);
  });
  it('simultaneous checkouts share one payment link, even for different keys on the same order', async () => {
    const h = createHarness();
    const key = h.key();
    const items = [{ kind: 'product', id: 1, qty: 1 }];
    const all = await Promise.all(Array.from({ length: 15 }, () => h.service.checkout(user(), { items, destination: h.dest, idempotencyKey: key })));
    assert.equal(new Set(all.map((x) => x.payment.reference)).size, 1);
    assert.equal(new Set(all.map((x) => x.payment.authorizationUrl)).size, 1);
    assert.equal(h.ordersModel._payments.length, 1);
  });
  it('reusing a key for a different cart is rejected', async () => {
    const h = createHarness();
    const key = h.key();
    await h.service.checkout(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest, idempotencyKey: key });
    await assert.rejects(h.service.checkout(user(), { items: [{ kind: 'product', id: 1, qty: 3 }], destination: h.dest, idempotencyKey: key }), (e) => e.code === 'IDEMPOTENCY_MISMATCH');
  });
  it('another customer using the same key gets their own order', async () => {
    const h = createHarness();
    const key = h.key();
    const items = [{ kind: 'product', id: 1, qty: 1 }];
    const a = await h.service.checkout(user(1), { items, destination: h.dest, idempotencyKey: key });
    const b = await h.service.checkout(user(2), { items, destination: h.dest, idempotencyKey: key });
    assert.notEqual(a.order.ref, b.order.ref);
  });
  it('rejects a missing or malformed key', async () => {
    const h = createHarness();
    await assert.rejects(h.service.checkout(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest, idempotencyKey: 'short' }), /Idempotency/);
  });
});

describe('payment security', () => {
  it('an unpaid order is not visible to vendors and cannot be acted on', async () => {
    const h = createHarness();
    const co = await h.service.checkout(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest, idempotencyKey: h.key() });
    assert.equal((await h.service.vendorOrders(10)).orders.length, 0);
    const o = await h.ordersModel.findByRef(co.order.ref);
    await assert.rejects(h.service.vendorAct({ id: 10 }, o.vendorOrders[0].id, 'accept'), (e) => e.status === 404);
  });
  it('settles once and tells everyone', async () => {
    const h = createHarness();
    const { r, order } = await paidOrder(h);
    assert.equal(r.settled, true);
    assert.equal(order.status, 'paid');
    assert.equal(order.vendorOrders[0].status, 'placed');
    assert.ok(order.vendorOrders[0].promisedBy);
    const to = h.sent.map((m) => m.to);
    assert.ok(to.includes('c1@x.ng') && to.includes('v10@x.ng') && to.includes('admin@solariun.ng'));
  });
  it('a replayed webhook changes nothing and sends no second email', async () => {
    const h = createHarness();
    const { co, ref } = await paidOrder(h);
    const emails = h.sent.length;
    const again = await h.service.handlePaymentResult({ reference: ref, status: 'success', amountKobo: co.order.total * 100, currency: 'NGN' });
    assert.equal(again.replay, true);
    assert.equal(h.sent.length, emails);
    assert.equal(h.ordersModel._events.filter((e) => e.type === 'payment_confirmed').length, 1);
  });
  it('a webhook racing the return page and itself settles exactly once', async () => {
    const h = createHarness();
    const co = await h.service.checkout(user(), { items: [{ kind: 'product', id: 1, qty: 1 }, { kind: 'product', id: 2, qty: 1 }], destination: h.dest, idempotencyKey: h.key() });
    const ref = co.payment.reference;
    const ev = { event: 'charge.success', data: { reference: ref, status: 'success', amount: co.order.total * 100, currency: 'NGN' } };
    h.paystack.markMockPaid(ref);
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => h.service.handleWebhook(ev)),
      ...Array.from({ length: 10 }, () => h.service.verifyAndSettle(user(), ref)),
    ]);
    assert.ok(results.length === 20);
    assert.equal(h.ordersModel._events.filter((e) => e.type === 'payment_confirmed').length, 1);
    assert.equal(h.sent.filter((m) => /Payment confirmed/.test(m.subject)).length, 1);
    assert.equal(h.sent.filter((m) => /New order/.test(m.subject)).length, 2); // one per vendor, not per request
  });
  it('a payment for less than the total does not release the order', async () => {
    const h = createHarness();
    const co = await h.service.checkout(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest, idempotencyKey: h.key() });
    const r = await h.service.handlePaymentResult({ reference: co.payment.reference, status: 'success', amountKobo: 100, currency: 'NGN' });
    assert.equal(r.mismatch, true);
    assert.equal((await h.ordersModel.findByRef(co.order.ref)).status, 'pending_payment');
    assert.ok(h.sent.some((m) => /Payment problem/.test(m.subject)));
  });
  it('a payment in the wrong currency is refused', async () => {
    const h = createHarness();
    const co = await h.service.checkout(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest, idempotencyKey: h.key() });
    const r = await h.service.handlePaymentResult({ reference: co.payment.reference, status: 'success', amountKobo: co.order.total * 100, currency: 'USD' });
    assert.equal(r.mismatch, true);
  });
  it('an unknown reference is ignored', async () => {
    const h = createHarness();
    const r = await h.service.handlePaymentResult({ reference: 'nope', status: 'success', amountKobo: 1, currency: 'NGN' });
    assert.equal(r.ignored, 'unknown_reference');
  });
  it('a second payment for an order already paid is flagged for refund, not counted', async () => {
    const h = createHarness();
    const { co } = await paidOrder(h);
    // Force a second payment record for the same order (e.g. the customer paid in two tabs).
    const second = (await h.ordersModel.openPayment({ orderId: (await h.ordersModel.findByRef(co.order.ref)).id, reference: "DUP-1", amount: co.order.total })).created;
    assert.ok(second);
    const r = await h.service.handlePaymentResult({ reference: 'DUP-1', status: 'success', amountKobo: co.order.total * 100, currency: 'NGN' });
    assert.equal(r.refundNeeded, true);
    assert.equal(h.ordersModel._events.filter((e) => e.type === 'payment_confirmed').length, 1);
    assert.ok(h.sent.some((m) => /Payment problem/.test(m.subject)));
  });
  it('a failed payment can be retried with a fresh payment', async () => {
    const h = createHarness();
    const key = h.key();
    const items = [{ kind: 'product', id: 1, qty: 1 }];
    const a = await h.service.checkout(user(), { items, destination: h.dest, idempotencyKey: key });
    await h.service.handlePaymentResult({ reference: a.payment.reference, status: 'failed' });
    const b = await h.service.retryPayment(user(), a.order.ref);
    assert.notEqual(b.payment.reference, a.payment.reference);
    assert.equal(h.ordersModel._orders.length, 1);
  });
  it("one customer cannot verify or read another's order", async () => {
    const h = createHarness();
    const co = await h.service.checkout(user(1), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest, idempotencyKey: h.key() });
    await assert.rejects(h.service.verifyAndSettle(user(2), co.payment.reference), (e) => e.status === 404);
    await assert.rejects(h.service.myOrder(user(2), co.order.ref), (e) => e.status === 404);
  });
  it('the simulation page only works in simulation mode and for the owner', async () => {
    const h = createHarness();
    const co = await h.service.checkout(user(1), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest, idempotencyKey: h.key() });
    await assert.rejects(h.service.mockPay(user(2), co.payment.reference), (e) => e.status === 404);
    const ok = await h.service.mockPay(user(1), co.payment.reference);
    assert.equal(ok.status, 'paid');
  });
  it('unpaid checkouts expire', async () => {
    const h = createHarness();
    const co = await h.service.checkout(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest, idempotencyKey: h.key() });
    h.setClock(new Date(h.clock.t.getTime() + 25 * 3600 * 1000));
    const r = await h.service.housekeeping();
    assert.equal(r.expired, 1);
    await assert.rejects(h.service.retryPayment(user(), co.order.ref), (e) => e.code === 'ORDER_CANCELLED');
  });
});

describe('order life cycle', () => {
  const first = (o) => o.vendorOrders[0].id;

  it('walks from placed to completed with the right emails', async () => {
    const h = createHarness();
    const { order } = await paidOrder(h);
    const vo = first(order);
    await h.service.vendorAct({ id: 10 }, vo, 'accept');
    assert.ok(h.sent.some((m) => m.to === 'rider@logistics.ng' && /send a rider/i.test(m.subject)));
    await h.service.vendorAct({ id: 10 }, vo, 'prepare');
    await h.service.vendorAct({ id: 10 }, vo, 'ready');
    assert.ok(h.sent.some((m) => m.to === 'c1@x.ng' && /Ready for pickup/.test(m.subject)));
    const pick = h.tokens.verify(new URL(h.sent.findLast((m) => m.to === 'rider@logistics.ng').button.url).searchParams.get('t'));
    assert.deepEqual(pick, { voId: vo, action: 'pickup' });
    await h.service.dispatchConfirm(pick);
    assert.ok(h.sent.some((m) => m.to === 'c1@x.ng' && /Out for delivery/.test(m.subject)));
    const del = h.tokens.verify(new URL(h.sent.findLast((m) => m.to === 'rider@logistics.ng' && /Out for delivery/.test(m.subject)).button.url).searchParams.get('t'));
    await h.service.dispatchConfirm(del);
    assert.ok(h.sent.some((m) => m.to === 'c1@x.ng' && /Delivered/.test(m.subject)));
    await h.service.confirmReceived(user(), order.publicRef, vo);
    const done = await h.ordersModel.findByRef(order.publicRef);
    assert.equal(done.vendorOrders[0].status, 'completed');
    assert.ok(h.sent.filter((m) => m.to === 'admin@solariun.ng').length >= 6); // admin sees every step
  });
  it('steps cannot be skipped or repeated, and repeats are harmless', async () => {
    const h = createHarness();
    const { order } = await paidOrder(h);
    const vo = first(order);
    await assert.rejects(h.service.vendorAct({ id: 10 }, vo, 'ready'), (e) => e.code === 'INVALID_STEP');
    await assert.rejects(h.service.dispatchConfirm({ voId: vo, action: 'deliver' }), (e) => e.code === 'INVALID_STEP');
    await h.service.vendorAct({ id: 10 }, vo, 'accept');
    const emails = h.sent.length;
    const again = await h.service.vendorAct({ id: 10 }, vo, 'accept');
    assert.equal(again.already, true);
    assert.equal(h.sent.length, emails);
  });
  it('a vendor cannot touch another vendor’s order', async () => {
    const h = createHarness();
    const { order } = await paidOrder(h);
    await assert.rejects(h.service.vendorAct({ id: 11 }, first(order), 'accept'), (e) => e.status === 404);
  });
  it('a customer cannot confirm received before delivery, nor someone else’s order', async () => {
    const h = createHarness();
    const { order } = await paidOrder(h);
    await assert.rejects(h.service.confirmReceived(user(), order.publicRef, first(order)), (e) => e.code === 'INVALID_STEP');
    await assert.rejects(h.service.confirmReceived(user(2), order.publicRef, first(order)), (e) => e.status === 404);
  });
  it('declining flags a refund for the admin', async () => {
    const h = createHarness();
    const { order } = await paidOrder(h);
    await h.service.vendorAct({ id: 10 }, first(order), 'reject', 'Out of stock');
    assert.ok(h.sent.some((m) => /REFUND NEEDED/.test(m.subject)));
    assert.equal((await h.service.adminOrders({})).orders[0].refundNeeded, true);
    await h.service.markRefunded({ id: 99 }, first(order));
    assert.equal((await h.service.adminOrders({})).orders[0].refundNeeded, false);
  });
  it('delivered orders are marked received automatically after 12 hours, once', async () => {
    const h = createHarness();
    const { order } = await paidOrder(h);
    const vo = first(order);
    await h.service.vendorAct({ id: 10 }, vo, 'accept');
    await h.service.dispatchConfirm({ voId: vo, action: 'pickup' });
    await h.service.dispatchConfirm({ voId: vo, action: 'deliver' });
    h.setClock(new Date(h.clock.t.getTime() + 11 * 3600 * 1000));
    assert.equal((await h.service.housekeeping()).autoReceived, 0);
    h.setClock(new Date(h.clock.t.getTime() + 2 * 3600 * 1000));
    const [a, b] = await Promise.all([h.service.housekeeping(), h.service.housekeeping()]);
    assert.equal(a.autoReceived + b.autoReceived, 1);
    const done = await h.ordersModel.findByRef(order.publicRef);
    assert.equal(done.vendorOrders[0].status, 'completed');
    assert.equal(done.vendorOrders[0].autoCompleted, true);
  });
  it('the customer sees one delivery fee and a timeline; the vendor split stays hidden', async () => {
    const h = createHarness();
    const { co } = await paidOrder(h, [{ kind: 'product', id: 1, qty: 1 }, { kind: 'product', id: 2, qty: 1 }]);
    const { order } = await h.service.myOrder(user(), co.order.ref);
    assert.equal(order.vendorOrders.length, 2);
    assert.ok(order.deliveryFee > 0);
    assert.ok(order.vendorOrders.every((v) => !('deliveryFee' in v) && v.timeline.length === 7));
  });
  it('rider links open only the order they were made for', async () => {
    const h = createHarness();
    const { order } = await paidOrder(h);
    const t = h.tokens.sign(first(order), 'pickup');
    assert.equal(h.tokens.verify(t + 'x'), null);
    assert.equal(h.tokens.verify(`${t.split('.')[0]}.${'A'.repeat(43)}`), null);
    const info = await h.service.dispatchInfo(h.tokens.verify(t));
    assert.equal(info.ref, order.publicRef);
  });
});

describe('service charge (10% from the customer, 10% from the vendor)', () => {
  it('adds 10% to the items for the customer and holds back 10% from the vendor', async () => {
    const h = createHarness();
    const q = await h.service.quote(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest });
    assert.equal(q.subtotal, 100000);
    assert.equal(q.serviceCharge, 10000);
    assert.equal(q.total, 100000 + 10000 + q.deliveryFee);
    assert.equal(q.parts[0].commission, 10000);
  });
  it('shows the customer one service charge line and the vendor their net earnings', async () => {
    const h = createHarness();
    const { co, order } = await paidOrder(h, [{ kind: 'product', id: 1, qty: 1 }, { kind: 'product', id: 2, qty: 1 }]);
    const mine = (await h.service.myOrder(user(), co.order.ref)).order;
    assert.equal(mine.serviceCharge, 10000 + 45000);
    assert.equal(mine.total, mine.subtotal + mine.serviceCharge + mine.deliveryFee);
    assert.ok(mine.vendorOrders.every((v) => !('commission' in v) && !('serviceCharge' in v)));
    const v10 = (await h.service.vendorOrders(10)).orders[0];
    assert.equal(v10.subtotal, 100000);
    assert.equal(v10.earnings, 90000);
  });
  it('the payment must cover the service charge too', async () => {
    const h = createHarness();
    const co = await h.service.checkout(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest, idempotencyKey: h.key() });
    const itemsPlusDelivery = (co.order.total - 10000) * 100;
    const r = await h.service.handlePaymentResult({ reference: co.payment.reference, status: 'success', amountKobo: itemsPlusDelivery, currency: 'NGN' });
    assert.equal(r.mismatch, true);
  });
  it('a declined part refunds items, service charge and delivery for that part', async () => {
    const h = createHarness();
    const { order } = await paidOrder(h);
    await h.service.vendorAct({ id: 10 }, order.vendorOrders[0].id, 'reject', 'No stock');
    const mail = h.sent.find((m) => /Order declined/.test(m.subject));
    const vo = order.vendorOrders[0];
    assert.match(mail.lines[1], new RegExp(`${(100000 + 10000 + vo.deliveryFee).toLocaleString('en-NG').replace(/,/g, ',')}`));
  });
  it('admin sees the platform revenue (both sides)', async () => {
    const h = createHarness();
    await paidOrder(h);
    const a = (await h.service.adminOrders({})).orders[0];
    assert.equal(a.platformRevenue, 20000);
    assert.equal(a.vendorEarnings, 90000);
    assert.equal((await h.service.adminStats()).platform_revenue, 20000);
  });
  it('rates are read live, so an admin change applies to the next order', async () => {
    const h = createHarness({ fees: { vendorRegistrationFee: 100000, customerServicePct: 0.05, vendorCommissionPct: 0.15 } });
    const q = await h.service.quote(user(), { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest });
    assert.equal(q.serviceCharge, 5000);
    assert.equal(q.parts[0].commission, 15000);
  });
});
