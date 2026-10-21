import crypto from 'node:crypto';
import { HttpError } from '../lib/httpError.js';
import { estimateDelivery, latestOf, SLA_RULES } from '../utils/sla.js';
import { findArea, stateName } from '../utils/areas.js';
import { FEE_RULES, customerServiceCharge, vendorCommission } from '../utils/fees.js';
import { ACTIONS, STATUS_LABEL, buildTimeline } from '../utils/lifecycle.js';

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (n) => Array.from(crypto.randomBytes(n), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const HOUR = 3600 * 1000;

const bad = (code, message, details, status = 400) => new HttpError(status, code, message, details);

// Everything about buying: pricing a cart, taking payment, and moving each vendor's part of an order to the customer.
// Models, Paystack and the notifier are injected, so the rules can be tested without a database or the internet.
export function createOrdersService({ productsModel, dealsModel, ordersModel, feesService, paystack, notifier, config, feeRules = FEE_RULES, sla = SLA_RULES, now = () => new Date() }) {
  const visible = (vendorVerification) => (config.requireVerified ? vendorVerification === 'verified' : vendorVerification !== 'rejected');

  // ---------- pricing a cart ----------

  // Turns the cart into priced lines, one delivery fee per vendor, and a delivery time. Prices always come from the
  // database, never from what the browser sent.
  async function quote(user, { items, destination }) {
    if (user.role !== 'individual' && user.role !== 'business') {
      throw bad('FORBIDDEN', 'Switch to a shopping account (individual or business) to place an order.', null, 403);
    }
    // Merge repeats of the same item so one cart line cannot be split to dodge the quantity limit.
    const merged = new Map();
    for (const it of items) {
      const k = `${it.kind}:${it.id}`;
      merged.set(k, { ...it, qty: (merged.get(k)?.qty ?? 0) + it.qty });
    }
    const lines = [...merged.values()];
    if (lines.some((l) => l.qty > config.maxQty)) throw bad('VALIDATION_ERROR', `You can order up to ${config.maxQty} of one item.`);

    const productIds = lines.filter((l) => l.kind === 'product').map((l) => l.id);
    const products = new Map((await productsModel.findManyByIds(productIds)).map((p) => [p.id, p]));
    const deals = new Map();
    for (const l of lines.filter((x) => x.kind === 'deal')) {
      const d = await dealsModel.findActive(l.id, { requireVerified: config.requireVerified });
      if (d) deals.set(d.id, d);
    }

    const priced = [];
    const issues = [];
    for (const l of lines) {
      const src = l.kind === 'product' ? products.get(l.id) : deals.get(l.id);
      const problem = (reason) => issues.push({ kind: l.kind, id: l.id, reason });
      if (!src) { problem('This item is no longer available.'); continue; }
      let unitPrice;
      let name;
      if (l.kind === 'product') {
        if (src.status !== 'active' || !src.inStock || !visible(src.vendorVerification)) { problem(`${src.name} is not available right now.`); continue; }
        unitPrice = src.price;
        name = src.brand ? `${src.brand} ${src.name}` : src.name;
      } else {
        if (src.buyPrice == null || src.items.some((i) => i.productStatus === 'archived')) { problem(`${src.title} cannot be bought outright right now.`); continue; }
        unitPrice = src.buyPrice;
        name = src.title;
      }
      if (!src.vendorState || !src.vendorArea) { problem(`${src.vendorName} has not set a pickup location yet.`); continue; }
      if (src.vendorState !== destination.state) { problem(`${src.vendorName} does not deliver to ${stateName(destination.state)}.`); continue; }
      priced.push({
        kind: l.kind, refId: src.id, name, imageId: src.imageId ?? null, imageUrl: src.imageUrl ?? null, qty: l.qty,
        unitPrice, lineTotal: unitPrice * l.qty, vendorId: src.vendorId, vendorName: src.vendorName, vendorState: src.vendorState, vendorArea: src.vendorArea,
      });
    }
    if (issues.length) throw bad('CART_ISSUES', 'Some items in your cart can no longer be bought for this address.', { issues }, 409);
    if (priced.length === 0) throw bad('VALIDATION_ERROR', 'Your cart is empty.');

    // One delivery fee per vendor, from where that vendor is to where the customer is.
    const byVendor = new Map();
    for (const l of priced) {
      const v = byVendor.get(l.vendorId) ?? { vendorId: l.vendorId, vendorName: l.vendorName, state: l.vendorState, areaId: l.vendorArea, lines: [], subtotal: 0 };
      v.lines.push(l);
      v.subtotal += l.lineTotal;
      byVendor.set(l.vendorId, v);
    }
    const { fees, unreachable } = await feesService.quote([...byVendor.values()], { state: destination.state, areaId: destination.areaId });
    if (unreachable.length) throw bad('CART_ISSUES', 'Some vendors cannot deliver to this address.', { issues: unreachable.map((id) => ({ kind: 'vendor', id, reason: `${byVendor.get(id).vendorName} cannot deliver to this address.` })) }, 409);

    const placedAt = now();
    const parts = [...byVendor.values()].map((v) => {
      const f = fees.get(v.vendorId);
      return {
        vendorId: v.vendorId, vendorName: v.vendorName, subtotal: v.subtotal, deliveryFee: f.fee, distanceKm: f.distanceKm,
        serviceCharge: customerServiceCharge(v.subtotal, feeRules), // added to what the customer pays
        commission: vendorCommission(v.subtotal, feeRules), // held back from what the vendor receives
        items: v.lines,
        sla: estimateDelivery({ placedAt, distanceKm: f.distanceKm, zone: f.zone, lines: v.lines.length }, sla),
      };
    });
    const subtotal = parts.reduce((s, p) => s + p.subtotal, 0);
    const deliveryFee = parts.reduce((s, p) => s + p.deliveryFee, 0);
    const serviceCharge = parts.reduce((s, p) => s + p.serviceCharge, 0);
    const total = subtotal + serviceCharge + deliveryFee;
    if (total > config.maxTotal) throw bad('VALIDATION_ERROR', 'That order is too large to pay for online. Please split it or contact us.');
    return { lines: priced, parts, subtotal, serviceCharge, deliveryFee, total, delivery: latestOf(parts.map((p) => p.sla)) };
  }

  // What the customer sees: one delivery fee, however many vendors are involved.
  const publicQuote = (q) => ({
    lines: q.lines.map(({ kind, refId, name, imageUrl, qty, unitPrice, lineTotal, vendorName }) => ({ kind, id: refId, name, imageUrl, qty, unitPrice, lineTotal, vendorName })),
    subtotal: q.subtotal,
    serviceCharge: q.serviceCharge,
    deliveryFee: q.deliveryFee,
    total: q.total,
    vendorCount: q.parts.length,
    delivery: { promisedBy: q.delivery.promisedBy, expectedAt: q.delivery.expectedAt, afterHours: q.delivery.afterHours },
  });

  // ---------- paying ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // One open payment per order. Requests that arrive together share it: the first starts it with Paystack,
  // the others wait a moment for its payment link.
  async function ensurePayment(order, user) {
    const { payment, created } = await ordersModel.openPayment({ orderId: order.id, reference: `${order.publicRef}-${randomCode(6)}`, amount: order.total });
    if (!created) {
      for (let i = 0; i < 20 && !payment.authorizationUrl; i += 1) {
        const latest = await ordersModel.latestPayment(order.id);
        if (latest?.authorizationUrl && latest.status === 'initiated') return { reference: latest.reference, authorizationUrl: latest.authorizationUrl };
        if (latest && latest.status !== 'initiated') return ensurePayment(order, user); // that attempt failed: start a fresh one
        await sleep(config.pollMs ?? 300);
      }
      if (!payment.authorizationUrl) throw bad('PAYMENT_UNAVAILABLE', 'Your payment is still being set up. Please try again in a moment.', null, 503);
      return { reference: payment.reference, authorizationUrl: payment.authorizationUrl };
    }
    try {
      const init = await paystack.initialize({
        email: user.email,
        amountKobo: order.total * 100,
        reference: payment.reference,
        callbackUrl: config.callbackUrl,
        metadata: { orderRef: order.publicRef, customerId: user.id },
      });
      await ordersModel.setPaymentAuth(payment.id, { url: init.authorizationUrl, accessCode: init.accessCode });
      return { reference: payment.reference, authorizationUrl: init.authorizationUrl };
    } catch (err) {
      await ordersModel.failPayment(payment.id);
      console.error('[pay] could not start payment:', err.message);
      throw bad('PAYMENT_UNAVAILABLE', 'We could not start the payment. Please try again in a moment.', null, 502);
    }
  }

  // Creates the order and starts the payment. The same key always gives back the same order, so a double click,
  // a refresh or a network retry never produces two orders or two charges.
  async function checkout(user, { items, destination, idempotencyKey }) {
    if (!KEY.test(idempotencyKey ?? '')) throw bad('VALIDATION_ERROR', 'Missing or invalid Idempotency-Key.');
    const q = await quote(user, { items, destination });

    let order = await ordersModel.findByIdempotency(user.id, idempotencyKey);
    if (order) {
      if (order.total !== q.total) throw bad('IDEMPOTENCY_MISMATCH', 'This checkout was already started with different items. Please refresh your cart.', null, 409);
    } else {
      const res = await ordersModel.createOrder({
        publicRef: `SL-${randomCode(8)}`,
        customerId: user.id,
        ship: { name: destination.name, phone: destination.phone, address: destination.line, state: destination.state, area: destination.areaId },
        subtotal: q.subtotal, serviceCharge: q.serviceCharge, deliveryFee: q.deliveryFee, total: q.total, idempotencyKey,
        vendorOrders: q.parts.map((p) => ({ vendorId: p.vendorId, subtotal: p.subtotal, serviceCharge: p.serviceCharge, commission: p.commission, deliveryFee: p.deliveryFee, distanceKm: p.distanceKm, items: p.items })),
      });
      order = res.order;
      if (res.created) await ordersModel.addEvent({ orderId: order.id, actorType: 'customer', actorId: user.id, type: 'order_created' });
    }
    if (order.status === 'paid') return { order: orderSummary(order), alreadyPaid: true };
    if (order.status === 'cancelled') throw bad('ORDER_CANCELLED', 'This order has expired. Please start a new checkout.', null, 409);
    return { order: orderSummary(order), payment: await ensurePayment(order, user) };
  }

  // Pay again for an order that is still waiting (the customer closed the payment page).
  async function retryPayment(user, ref) {
    const order = await ownedOrder(user, ref);
    if (order.status === 'paid') return { order: orderSummary(order), alreadyPaid: true };
    if (order.status !== 'pending_payment') throw bad('ORDER_CANCELLED', 'This order has expired. Please start a new checkout.', null, 409);
    return { order: orderSummary(order), payment: await ensurePayment(order, user) };
  }

  // The one place a payment is counted. Webhooks, the return page and duplicates all come through here and
  // the result is the same however many times, and in whatever order, they arrive.
  async function handlePaymentResult({ reference, status, amountKobo = null, currency = null }) {
    const payment = await ordersModel.findPayment(reference);
    if (!payment) return { settled: false, ignored: 'unknown_reference' };
    const order = await ordersModel.getById(payment.orderId);
    if (payment.status === 'success') return { settled: true, replay: true, order };

    if (status !== 'success') {
      if (status === 'failed') {
        await ordersModel.failPayment(payment.id);
        await ordersModel.addEvent({ orderId: order.id, actorType: 'system', type: 'payment_failed', note: reference });
      }
      return { settled: false, status };
    }

    // The amount paid must be exactly what we asked for. A customer cannot pay less and keep the goods.
    const expectedKobo = Math.round(order.total * 100);
    if ((amountKobo != null && amountKobo !== expectedKobo) || (currency != null && currency !== 'NGN') || payment.amount !== order.total) {
      await ordersModel.addEvent({ orderId: order.id, actorType: 'system', type: 'payment_mismatch', note: `${reference}: paid ${amountKobo} ${currency}, expected ${expectedKobo} NGN` });
      await notifier.notify('payment_problem', { order, reference, reason: `The amount paid does not match the order (paid ${amountKobo}, expected ${expectedKobo} kobo). The order was NOT released.` });
      return { settled: false, mismatch: true };
    }

    const paidAt = now();
    const zone = findArea(order.shipState, order.shipArea)?.zone ?? 'Inner';
    const promised = new Map(order.vendorOrders.map((vo) => [vo.id, new Date(estimateDelivery({ placedAt: paidAt, distanceKm: vo.distanceKm, zone, lines: vo.items.length }, sla).promisedBy)]));
    const res = await ordersModel.settlePayment({ orderId: order.id, paymentId: payment.id, paidAt, promised });

    if (res.replay) return { settled: true, replay: true, order: await ordersModel.getById(order.id) };
    if (!res.won) {
      // Money arrived for an order that cannot use it: a second payment for an order already paid, or a payment after expiry.
      const reason = res.orderStatus === 'paid' ? 'A second payment arrived for an order that was already paid. Refund the duplicate.' : 'A payment arrived after the order expired. Refund it or recreate the order.';
      await ordersModel.addEvent({ orderId: order.id, actorType: 'system', type: 'payment_refund_needed', note: `${reference}: ${reason}` });
      await notifier.notify('payment_problem', { order, reference, reason });
      return { settled: false, refundNeeded: true };
    }

    await ordersModel.addEvent({ orderId: order.id, actorType: 'system', type: 'payment_confirmed', note: reference });
    const parts = [];
    const customer = await customerOf(order);
    for (const vo of order.vendorOrders) {
      await ordersModel.addEvent({ orderId: order.id, voId: vo.id, actorType: 'system', type: 'placed' });
      parts.push(await fullCtx(vo.id));
    }
    await notifier.notify('payment_confirmed', { order: await ordersModel.getById(order.id), parts, customer });
    return { settled: true, order: await ordersModel.getById(order.id) };
  }

  // The customer's browser comes back from Paystack. We ask Paystack what happened instead of believing the browser.
  async function verifyAndSettle(user, reference) {
    const payment = await ordersModel.findPayment(reference);
    const order = payment ? await ordersModel.getById(payment.orderId) : null;
    if (!order || order.customerId !== user.id) throw bad('NOT_FOUND', 'Payment not found.', null, 404);
    if (order.status === 'paid') return { status: 'paid', orderRef: order.publicRef };
    let v;
    try {
      v = await paystack.verify(reference);
    } catch (err) {
      console.error('[pay] verify failed:', err.message);
      throw bad('PAYMENT_UNAVAILABLE', 'We could not confirm the payment yet. If you were charged, it will update shortly.', null, 502);
    }
    const r = await handlePaymentResult({ reference, status: v.status, amountKobo: v.amountKobo ?? null, currency: v.currency ?? null });
    return { status: r.settled ? 'paid' : v.status === 'failed' ? 'failed' : 'pending', orderRef: order.publicRef };
  }

  // A signed Paystack event. The route has already checked the signature.
  async function handleWebhook(body) {
    const event = body?.event;
    const data = body?.data ?? {};
    if (!data.reference) return { ignored: true };
    await ordersModel.recordWebhook(`${event}:${data.reference}`); // an audit trail; correctness comes from the atomic claim, not from this
    if (event === 'charge.success') {
      return handlePaymentResult({ reference: data.reference, status: data.status === 'success' ? 'success' : data.status, amountKobo: data.amount, currency: data.currency });
    }
    if (event === 'charge.failed') return handlePaymentResult({ reference: data.reference, status: 'failed' });
    return { ignored: true };
  }

  // Simulation only (no Paystack key): the "payment page" button calls this.
  async function mockPay(user, reference) {
    if (!paystack.mock) throw bad('NOT_FOUND', 'Not found.', null, 404);
    const payment = await ordersModel.findPayment(reference);
    const order = payment ? await ordersModel.getById(payment.orderId) : null;
    if (!order || order.customerId !== user.id) throw bad('NOT_FOUND', 'Payment not found.', null, 404);
    paystack.markMockPaid(reference);
    return verifyAndSettle(user, reference);
  }

  // ---------- moving an order along ----------

  const customerOf = async (order) => {
    const full = await fullCtx(order.vendorOrders[0].id);
    return full.customer;
  };

  async function fullCtx(voId) {
    const f = await ordersModel.getVendorOrderFull(voId);
    return { order: f.order, vo: f.vo, items: f.vo.items, customer: f.customer, vendor: f.vendor, autoReceiveHours: sla.autoReceiveHours };
  }

  const NOTIFY_FOR = { accept: 'accepted', prepare: 'preparing', ready: 'ready', reject: 'rejected', pickup: 'picked_up', deliver: 'delivered', receive: 'completed', autoReceive: 'completed' };

  // One step on one vendor order, taken by `actor` ({ type, id }). The step only happens if the order is in the
  // right state, and only once, even if two people press it at the same moment.
  async function act({ voId, action, actor, note = null }) {
    const def = ACTIONS[action];
    if (!def || !def.actors.includes(actor.type)) throw bad('FORBIDDEN', 'You cannot do that.', null, 403);
    const before = await ordersModel.getVendorOrderFull(voId);
    if (!before || before.order.status !== 'paid') throw bad('NOT_FOUND', 'Order not found.', null, 404);
    if (actor.type === 'vendor' && before.vo.vendorId !== actor.id) throw bad('NOT_FOUND', 'Order not found.', null, 404);
    if (actor.type === 'customer' && before.order.customerId !== actor.id) throw bad('NOT_FOUND', 'Order not found.', null, 404);

    const ok = await ordersModel.transition(voId, def, now());
    if (!ok) {
      const current = (await ordersModel.getVendorOrderFull(voId)).vo.status;
      // Pressing the same button twice (or the rider tapping the link twice) is harmless.
      if (current === def.to) return { already: true, status: current };
      throw bad('INVALID_STEP', `This order is "${STATUS_LABEL[current].toLowerCase()}", so that step is not available.`, { status: current }, 409);
    }
    if (def.refund) await ordersModel.flagRefund(voId);
    await ordersModel.addEvent({ orderId: before.order.id, voId, actorType: actor.type, actorId: actor.id ?? null, type: action === 'autoReceive' ? 'auto_received' : action, note });

    const ctx = await fullCtx(voId);
    await notifier.notify(NOTIFY_FOR[action], { ...ctx, note, auto: action === 'autoReceive' });
    return { already: false, status: def.to };
  }

  // ---------- views ----------

  async function ownedOrder(user, ref) {
    const order = await ordersModel.findByRef(ref);
    if (!order || order.customerId !== user.id) throw bad('NOT_FOUND', 'Order not found.', null, 404);
    return order;
  }

  const orderSummary = (o) => ({ ref: o.publicRef, status: o.status, total: o.total });

  const customerVo = (vo, order) => ({
    id: vo.id,
    vendorName: vo.vendorName,
    status: vo.status,
    statusLabel: STATUS_LABEL[vo.status],
    items: vo.items.map(({ name, imageUrl, qty, unitPrice, lineTotal }) => ({ name, imageUrl, qty, unitPrice, lineTotal })),
    subtotal: vo.subtotal,
    promisedBy: vo.promisedBy,
    timeline: buildTimeline(vo, order.paidAt),
    canConfirmReceived: vo.status === 'delivered',
    autoReceiveAt: vo.delivered_at ? new Date(new Date(vo.delivered_at).getTime() + sla.autoReceiveHours * HOUR).toISOString() : null,
    autoCompleted: vo.autoCompleted,
  });

  // The customer sees one delivery fee for the whole order.
  const customerOrder = (o) => ({
    ref: o.publicRef,
    status: o.status,
    subtotal: o.subtotal,
    serviceCharge: o.serviceCharge,
    deliveryFee: o.deliveryFee,
    total: o.total,
    ship: { name: o.shipName, phone: o.shipPhone, address: o.shipAddress, state: o.shipState, stateName: stateName(o.shipState), areaId: o.shipArea, areaName: findArea(o.shipState, o.shipArea)?.name },
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    vendorOrders: o.vendorOrders.map((vo) => customerVo(vo, o)),
  });

  const vendorView = (vo) => ({
    id: vo.id,
    ref: vo.order.publicRef,
    status: vo.status,
    statusLabel: STATUS_LABEL[vo.status],
    items: vo.items.map(({ name, imageUrl, qty, unitPrice, lineTotal }) => ({ name, imageUrl, qty, unitPrice, lineTotal })),
    subtotal: vo.subtotal,
    commission: vo.commission, // the platform fee held back
    earnings: vo.subtotal - vo.commission, // what the vendor receives for this order
    customer: { name: vo.order.shipName },
    deliverTo: { state: vo.order.shipState, stateName: stateName(vo.order.shipState), areaName: findArea(vo.order.shipState, vo.order.shipArea)?.name },
    paidAt: vo.order.paidAt,
    promisedBy: vo.promisedBy,
    acceptedAt: vo.accepted_at,
    readyAt: vo.ready_at,
    pickedUpAt: vo.picked_up_at,
    deliveredAt: vo.delivered_at,
    refundNeeded: vo.refundNeeded,
    late: Boolean(vo.promisedBy) && new Date(vo.promisedBy) < now() && !['delivered', 'completed', 'rejected', 'cancelled'].includes(vo.status),
  });

  const adminView = (f) => ({
    id: f.vo.id,
    ref: f.order.publicRef,
    status: f.vo.status,
    statusLabel: STATUS_LABEL[f.vo.status],
    vendor: { id: f.vendor.id, name: f.vendor.companyName, phone: f.vendor.phone, email: f.vendor.email, address: f.vendor.address },
    customer: { name: f.customer.fullName, email: f.customer.email, phone: f.order.shipPhone },
    deliverTo: { address: f.order.shipAddress, state: f.order.shipState, stateName: stateName(f.order.shipState), areaName: findArea(f.order.shipState, f.order.shipArea)?.name },
    items: f.vo.items.map(({ name, qty, lineTotal }) => ({ name, qty, lineTotal })),
    subtotal: f.vo.subtotal,
    serviceCharge: f.vo.serviceCharge,
    commission: f.vo.commission,
    platformRevenue: f.vo.serviceCharge + f.vo.commission,
    vendorEarnings: f.vo.subtotal - f.vo.commission,
    deliveryFee: f.vo.deliveryFee,
    distanceKm: f.vo.distanceKm,
    paidAt: f.order.paidAt,
    promisedBy: f.vo.promisedBy,
    acceptedAt: f.vo.accepted_at,
    readyAt: f.vo.ready_at,
    pickedUpAt: f.vo.picked_up_at,
    deliveredAt: f.vo.delivered_at,
    completedAt: f.vo.completed_at,
    autoCompleted: f.vo.autoCompleted,
    refundNeeded: f.vo.refundNeeded,
    late: Boolean(f.vo.promisedBy) && new Date(f.vo.promisedBy) < now() && !['delivered', 'completed', 'rejected', 'cancelled'].includes(f.vo.status),
  });

  // ---------- background work ----------

  // Run every few minutes: close delivered orders the customer never confirmed, and drop checkouts never paid for.
  async function housekeeping() {
    const t = now();
    const due = await ordersModel.dueForAutoReceive(new Date(t.getTime() - sla.autoReceiveHours * HOUR));
    let received = 0;
    for (const id of due) {
      try {
        const r = await act({ voId: id, action: 'autoReceive', actor: { type: 'system' } });
        if (!r.already) received += 1;
      } catch (err) {
        console.error('[orders] auto-receive failed for', id, err.message);
      }
    }
    const expired = await ordersModel.expirePending(new Date(t.getTime() - config.pendingExpiryHours * HOUR));
    return { autoReceived: received, expired: expired.length };
  }

  return {
    quote,
    publicQuote,
    checkout,
    retryPayment,
    verifyAndSettle,
    handleWebhook,
    handlePaymentResult,
    mockPay,
    act,
    housekeeping,

    async myOrders(user) {
      return { orders: (await ordersModel.listForCustomer(user.id)).filter((o) => o.status !== 'cancelled').map(customerOrder) };
    },
    async myOrder(user, ref) {
      const o = await ownedOrder(user, ref);
      const out = customerOrder(o);
      if (o.status === 'pending_payment') {
        const p = await ordersModel.latestPayment(o.id);
        out.payment = p?.status === 'initiated' ? { reference: p.reference, authorizationUrl: p.authorizationUrl } : null;
      }
      return { order: out };
    },
    confirmReceived: async (user, ref, voId) => {
      const o = await ownedOrder(user, ref);
      if (!o.vendorOrders.some((v) => v.id === voId)) throw bad('NOT_FOUND', 'Order not found.', null, 404);
      return act({ voId, action: 'receive', actor: { type: 'customer', id: user.id } });
    },

    async vendorOrders(vendorId, { status } = {}) {
      const list = await ordersModel.listForVendor(vendorId, { status });
      return { orders: list.map(vendorView) };
    },
    vendorAct: (vendor, voId, action, note) => {
      if (!['accept', 'prepare', 'ready', 'reject'].includes(action)) throw bad('NOT_FOUND', 'Not found.', null, 404);
      return act({ voId, action, actor: { type: 'vendor', id: vendor.id }, note });
    },

    async adminOrders(filter) {
      return { orders: (await ordersModel.listAll(filter)).map(adminView) };
    },
    adminStats: () => ordersModel.stats(),
    adminAct: (admin, voId, action, note) => {
      if (action === 'autoReceive') throw bad('NOT_FOUND', 'Not found.', null, 404);
      return act({ voId, action, actor: { type: 'admin', id: admin.id }, note });
    },
    async markRefunded(admin, voId) {
      if (!(await ordersModel.clearRefund(voId))) throw bad('NOT_FOUND', 'Nothing to mark.', null, 404);
      const f = await ordersModel.getVendorOrderFull(voId);
      await ordersModel.addEvent({ orderId: f.order.id, voId, actorType: 'admin', actorId: admin.id, type: 'refunded' });
      return { ok: true };
    },

    // The logistics partner's links: no account, just a signed token for one order and one step.
    async dispatchInfo(parsed) {
      const f = await ordersModel.getVendorOrderFull(parsed.voId);
      if (!f || f.order.status !== 'paid') throw bad('NOT_FOUND', 'This link is not valid.', null, 404);
      return {
        action: parsed.action,
        ref: f.order.publicRef,
        status: f.vo.status,
        statusLabel: STATUS_LABEL[f.vo.status],
        vendor: f.vendor.companyName,
        from: f.vendor.address ? `${f.vendor.address.line}, ${findArea(f.vendor.address.state, f.vendor.address.areaId)?.name}` : null,
        to: `${f.order.shipAddress}, ${findArea(f.order.shipState, f.order.shipArea)?.name}, ${stateName(f.order.shipState)}`,
        contact: { name: f.order.shipName, phone: f.order.shipPhone },
        items: f.vo.items.map((i) => `${i.qty} × ${i.name}`),
        promisedBy: f.vo.promisedBy,
        done: parsed.action === 'pickup' ? ['out_for_delivery', 'delivered', 'completed'].includes(f.vo.status) : ['delivered', 'completed'].includes(f.vo.status),
      };
    },
    dispatchConfirm: (parsed) => act({ voId: parsed.voId, action: parsed.action, actor: { type: 'logistics' } }),

    async adminTimeline(ref) {
      const o = await ordersModel.findByRef(ref);
      if (!o) throw bad('NOT_FOUND', 'Order not found.', null, 404);
      return { events: await ordersModel.events(o.id) };
    },
  };
}
