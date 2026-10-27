import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPaystack } from '../src/lib/paystack.js';
import { createSubscriptionService } from '../src/services/subscription.service.js';
import { extend, stateOf, subscriptionOkSql } from '../src/utils/subscription.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-01T10:00:00Z');
const rules = (o = {}) => ({ vendorSubscriptionSeller: 15000, vendorSubscriptionCompany: 40000, subscriptionGraceDays: 7, ...o });

function memoryModel() {
  const vendors = new Map([
    [10, { vendorId: 10, vendorType: 'seller', verification: 'verified', paidUntil: null, email: 's@x.ng', contactName: 'Sam', companyName: 'S Shop' }],
    [11, { vendorId: 11, vendorType: 'company', verification: 'verified', paidUntil: null, email: 'c@x.ng', contactName: 'Cee', companyName: 'C Ltd' }],
    [12, { vendorId: 12, vendorType: 'seller', verification: 'pending', paidUntil: null, email: 'p@x.ng', contactName: 'Pat', companyName: 'P' }],
  ]);
  const payments = [];
  let seq = 0;
  return {
    vendors, payments,
    async profile(id) { return vendors.get(id) ? { ...vendors.get(id) } : null; },
    async createPayment({ vendorId, reference, amount, months }) { const p = { id: ++seq, vendorId, reference, amount, months, status: 'initiated' }; payments.push(p); return { ...p }; },
    async find(ref) { const p = payments.find((x) => x.reference === ref); return p ? { ...p } : null; },
    async setAuth() {},
    async fail(id) { const p = payments.find((x) => x.id === id); if (p.status === 'initiated') p.status = 'failed'; },
    async history() { return payments.filter((p) => p.status === 'success'); },
    async settle({ paymentId, vendorId, days, paidAt }) {
      const p = payments.find((x) => x.id === paymentId);
      if (p.status === 'success') return { replay: true };
      p.status = 'success';
      const v = vendors.get(vendorId);
      v.paidUntil = extend(v.paidUntil, days, paidAt);
      return { replay: false, paidUntil: v.paidUntil };
    },
    async grant(id, days, now) { const v = vendors.get(id); if (!v) return null; v.paidUntil = extend(v.paidUntil, days, now); return v.paidUntil; },
    async grantAll(days, now, type) { let n = 0; for (const v of vendors.values()) if (v.verification === 'verified' && (!type || v.vendorType === type) && (!v.paidUntil || v.paidUntil < now)) { v.paidUntil = extend(null, days, now); n += 1; } return { updated: n }; },
    async listForAdmin() { return [...vendors.values()].map((v) => ({ ...v })); },
    async dueBetween(a, b) { return [...vendors.values()].filter((v) => v.paidUntil && v.paidUntil >= a && v.paidUntil <= b && !v.reminded).map((v) => ({ ...v, vendorId: v.vendorId, fullName: v.contactName })); },
    async markReminded(id) { vendors.get(id).reminded = true; },
    async lapsedBetween(a, b) { return [...vendors.values()].filter((v) => v.paidUntil && v.paidUntil >= a && v.paidUntil <= b && !v.lapsed).map((v) => ({ ...v, vendorId: v.vendorId, fullName: v.contactName })); },
    async markLapsedNotified(id) { vendors.get(id).lapsed = true; },
  };
}

function setup(over = {}) {
  let clock = T0;
  const model = memoryModel();
  const paystack = createPaystack({ secretKey: '', clientOrigin: 'http://localhost:5173', isProd: false });
  const sent = [];
  const svc = createSubscriptionService({
    subscriptionsModel: model, paystack, notifier: { async notify(t, c) { sent.push([t, c]); } },
    rules: rules(over), config: { callbackUrl: 'http://x/return' }, now: () => clock,
  });
  return { svc, model, paystack, sent, tick: (ms) => { clock = new Date(clock.getTime() + ms); }, clock: () => clock };
}
const seller = { id: 10, email: 's@x.ng' };
const company = { id: 11, email: 'c@x.ng' };

describe('subscription rules', () => {
  it('has no subscription when the price is 0', () => {
    assert.equal(stateOf({ vendorType: 'seller', paidUntil: null }, rules({ vendorSubscriptionSeller: 0 }), T0).ok, true);
    assert.equal(subscriptionOkSql('v', rules({ vendorSubscriptionSeller: 0, vendorSubscriptionCompany: 0 })), '1 = 1');
  });
  it('is active, then in grace, then lapsed', () => {
    const r = rules();
    const until = new Date(T0.getTime() + 10 * DAY);
    assert.equal(stateOf({ vendorType: 'seller', paidUntil: until }, r, T0).state, 'active');
    assert.equal(stateOf({ vendorType: 'seller', paidUntil: until }, r, new Date(until.getTime() + 3 * DAY)).state, 'grace');
    assert.equal(stateOf({ vendorType: 'seller', paidUntil: until }, r, new Date(until.getTime() + 8 * DAY)).state, 'lapsed');
    assert.equal(stateOf({ vendorType: 'seller', paidUntil: null }, r, T0).state, 'never');
  });
  it('extends from the old date when still paid up, otherwise from today', () => {
    assert.equal(extend(new Date(T0.getTime() + 5 * DAY), 30, T0).getTime(), T0.getTime() + 35 * DAY);
    assert.equal(extend(new Date(T0.getTime() - 5 * DAY), 30, T0).getTime(), T0.getTime() + 30 * DAY);
    assert.equal(extend(null, 30, T0).getTime(), T0.getTime() + 30 * DAY);
  });
  it('builds SQL from a formatted date only', () => {
    const sql = subscriptionOkSql('v', rules(), T0);
    assert.match(sql, /v\.subscription_paid_until >= '2026-10-25 10:00:00'/);
    assert.match(sql, /vendor_type = 'company'/);
  });
});

describe('paying the subscription', () => {
  it('charges the type price times the months', async () => {
    const { svc } = setup();
    assert.equal((await svc.start(seller, 1)).amount, 15000);
    assert.equal((await svc.start(seller, 3)).amount, 45000);
    assert.equal((await svc.start(company, 1)).amount, 40000);
    await assert.rejects(svc.start(seller, 2), (e) => e.code === 'VALIDATION_ERROR');
  });
  it('is not offered to a vendor who is not verified, or when the price is 0', async () => {
    const a = setup();
    await assert.rejects(a.svc.start({ id: 12, email: 'p@x.ng' }, 1), (e) => e.code === 'VENDOR_NOT_VERIFIED');
    const b = setup({ vendorSubscriptionSeller: 0 });
    await assert.rejects(b.svc.start(seller, 1), (e) => e.code === 'NO_FEE_DUE');
  });
  it('counts a payment once however often it is reported, and adds 30 days per month', async () => {
    const { svc, model, paystack } = setup();
    const { reference } = await svc.start(seller, 3);
    assert.equal(await svc.isActive(10), false);
    paystack.markMockPaid(reference);
    assert.deepEqual(await svc.verifyAndSettle(seller, reference), { status: 'paid' });
    await svc.verifyAndSettle(seller, reference);
    await svc.handleResult({ reference, status: 'success' });
    assert.equal(model.vendors.get(10).paidUntil.getTime(), T0.getTime() + 90 * DAY);
    assert.equal(await svc.isActive(10), true);
  });
  it('holds a payment with the wrong amount or currency', async () => {
    const { svc, model, sent } = setup();
    const { reference } = await svc.start(seller, 1);
    assert.equal((await svc.handleResult({ reference, status: 'success', amountKobo: 100, currency: 'NGN' })).mismatch, true);
    assert.equal((await svc.handleResult({ reference, status: 'success', amountKobo: 1500000, currency: 'USD' })).mismatch, true);
    assert.equal(model.vendors.get(10).paidUntil, null);
    assert.ok(sent.some(([t]) => t === 'payment_problem'));
  });
  it('lets nobody pay for or check another vendor\'s payment', async () => {
    const { svc } = setup();
    const { reference } = await svc.start(seller, 1);
    await assert.rejects(svc.verifyAndSettle(company, reference), (e) => e.code === 'NOT_FOUND');
  });
  it('ignores unknown references and wrong events in the webhook', async () => {
    const { svc } = setup();
    assert.equal((await svc.handleWebhook({ event: 'charge.success', data: { reference: 'SUB-NOPE', status: 'success', amount: 1, currency: 'NGN' } })).ignored, 'unknown_reference');
    assert.equal((await svc.handleWebhook({ event: 'transfer.success', data: { reference: 'x' } })).ignored, true);
  });
});

describe('gifts, grace and reminders', () => {
  it('an admin gift works and is limited to verified vendors in bulk', async () => {
    const { svc, model } = setup();
    assert.equal((await svc.adminGrantAll(1, 30, 'company')).updated, 1);
    assert.ok(model.vendors.get(11).paidUntil);
    assert.equal(model.vendors.get(10).paidUntil, null);
    await svc.adminGrant(1, 10, 10);
    assert.equal(await svc.isActive(10), true);
    await assert.rejects(svc.adminGrant(1, 99, 5), (e) => e.code === 'NOT_FOUND');
  });
  it('keeps listings through the grace period, then closes them', async () => {
    const { svc, tick } = setup();
    await svc.adminGrant(1, 10, 1);
    tick(2 * DAY);
    assert.equal(await svc.isActive(10), true); // 1 day past, inside 7 days of grace
    tick(7 * DAY);
    assert.equal(await svc.isActive(10), false);
  });
  it('sends one reminder before the end and one when listings close', async () => {
    const { svc, sent, tick } = setup();
    await svc.adminGrant(1, 10, 5);
    tick(3 * DAY);
    assert.equal((await svc.housekeeping()).reminded, 1);
    assert.equal((await svc.housekeeping()).reminded, 0);
    tick(10 * DAY);
    assert.equal((await svc.housekeeping()).lapsed, 1);
    assert.equal((await svc.housekeeping()).lapsed, 0);
    assert.deepEqual(sent.map(([t]) => t).filter((t) => t.startsWith('subscription_')), ['subscription_due', 'subscription_lapsed']);
  });
});
