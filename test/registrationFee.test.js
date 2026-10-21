import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPaystack } from '../src/lib/paystack.js';
import { FEE_RULES } from '../src/utils/fees.js';
import { createRegistrationFeeService } from '../src/services/registrationFee.service.js';

// A tiny in-memory vendors model with the same all-or-nothing rules as the SQL one.
function memoryVendors() {
  const profiles = new Map([[10, { registrationFee: 'unpaid' }], [11, { registrationFee: 'waived' }]]);
  const payments = [];
  let seq = 0;
  return {
    payments, profiles,
    async getProfile(id) { return profiles.get(id) ? { userId: id, ...profiles.get(id) } : null; },
    async openFeePayment({ vendorId, reference, amount }) {
      const open = payments.filter((p) => p.vendorId === vendorId && p.status === 'initiated').at(-1);
      if (open) return { payment: { ...open }, created: false };
      const p = { id: ++seq, vendorId, reference, amount, status: 'initiated', authorizationUrl: null };
      payments.push(p);
      return { payment: { ...p }, created: true };
    },
    async findFeePayment(ref) { const p = payments.find((x) => x.reference === ref); return p ? { ...p } : null; },
    async latestFeePayment(id) { const l = payments.filter((p) => p.vendorId === id).at(-1); return l ? { ...l } : null; },
    async setFeePaymentAuth(id, { url }) { payments.find((p) => p.id === id).authorizationUrl = url; },
    async failFeePayment(id) { const p = payments.find((x) => x.id === id); if (p.status === 'initiated') p.status = 'failed'; },
    async settleFeePayment({ paymentId, vendorId }) {
      const p = payments.find((x) => x.id === paymentId);
      if (p.status === 'success') return { won: false, replay: true };
      p.status = 'success';
      const prof = profiles.get(vendorId);
      if (prof.registrationFee !== 'unpaid') return { won: false, replay: false };
      prof.registrationFee = 'paid';
      return { won: true, replay: false };
    },
  };
}

function setup({ required = true } = {}) {
  const vendorsModel = memoryVendors();
  const paystack = createPaystack({ secretKey: '', clientOrigin: 'http://localhost:5173', isProd: false });
  const problems = [];
  const svc = createRegistrationFeeService({
    vendorsModel, paystack, notifier: { async notify(t, c) { problems.push([t, c]); } },
    rules: { ...FEE_RULES }, config: { required, callbackUrl: 'http://x/vendor/fee/return', pollMs: 1 },
  });
  return { svc, vendorsModel, paystack, problems };
}
const vendor = { id: 10, email: 'v@x.ng' };

describe('vendor registration fee (dormant until switched on)', () => {
  it('is ₦100,000 by default and gates only unpaid vendors', async () => {
    const { svc } = setup();
    assert.equal((await svc.status(10)).amount, 100000);
    assert.equal(await svc.isActive(10), false);
    assert.equal(await svc.isActive(11), true); // joined free: free for good
  });
  it('blocks nobody while registration is free', async () => {
    const { svc } = setup({ required: false });
    assert.equal(await svc.isActive(10), true);
    await assert.rejects(svc.start(vendor), (e) => e.code === 'NO_FEE_DUE');
  });
  it('simultaneous taps share one payment and one link', async () => {
    const { svc, vendorsModel } = setup();
    const all = await Promise.all(Array.from({ length: 10 }, () => svc.start(vendor)));
    assert.equal(new Set(all.map((a) => a.reference)).size, 1);
    assert.equal(vendorsModel.payments.length, 1);
    assert.equal(all[0].amount, 100000);
  });
  it('activates the vendor once paid, even with racing confirmations', async () => {
    const { svc, vendorsModel, paystack } = setup();
    const { reference } = await svc.start(vendor);
    paystack.markMockPaid(reference);
    const ev = { event: 'charge.success', data: { reference, status: 'success', amount: 100000 * 100, currency: 'NGN' } };
    const results = await Promise.all([...Array.from({ length: 5 }, () => svc.handleWebhook(ev)), ...Array.from({ length: 5 }, () => svc.verifyAndSettle(vendor, reference))]);
    assert.equal(results.length, 10);
    assert.equal(vendorsModel.profiles.get(10).registrationFee, 'paid');
    assert.equal(await svc.isActive(10), true);
  });
  it('holds a payment of the wrong amount and tells the admin', async () => {
    const { svc, vendorsModel, problems } = setup();
    const { reference } = await svc.start(vendor);
    const r = await svc.handleResult({ reference, status: 'success', amountKobo: 5000, currency: 'NGN' });
    assert.equal(r.mismatch, true);
    assert.equal(vendorsModel.profiles.get(10).registrationFee, 'unpaid');
    assert.equal(problems.length, 1);
  });
  it("another vendor cannot confirm someone else's payment", async () => {
    const { svc } = setup();
    const { reference } = await svc.start(vendor);
    await assert.rejects(svc.verifyAndSettle({ id: 11 }, reference), (e) => e.status === 404);
  });
  it('uses the admin-set amount', async () => {
    const { svc } = setup();
    const s2 = createRegistrationFeeService({ vendorsModel: memoryVendors(), paystack: createPaystack({ secretKey: '', clientOrigin: 'http://x', isProd: false }), rules: { vendorRegistrationFee: 150000 }, config: { required: true, callbackUrl: 'x', pollMs: 1 } });
    assert.equal((await s2.start(vendor)).amount, 150000);
  });
});
