import crypto from 'node:crypto';
import { HttpError } from '../lib/httpError.js';
import { SUBSCRIPTION_MONTHS, SUBSCRIPTION_PERIOD_DAYS, isRequired, priceFor, stateOf } from '../utils/subscription.js';

const bad = (status, code, message) => new HttpError(status, code, message);
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (n) => Array.from(crypto.randomBytes(n), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
export const SUB_REF_PREFIX = 'SUB-';
const DAY = 24 * 60 * 60 * 1000;

// The monthly subscription vendors (sellers and companies) pay to stay listed. Built like the registration fee and the
// installation payments: the amount comes from the admin's prices, each payment counts once however often it is reported,
// and a wrong amount is held, not counted. A price of 0 for a vendor type means that type pays nothing.
export function createSubscriptionService({ subscriptionsModel, paystack, notifier = null, auditModel = null, rules, config, now = () => new Date() }) {
  const describe = (profile) => {
    const st = stateOf({ vendorType: profile.vendorType, paidUntil: profile.paidUntil }, rules, now());
    const monthly = priceFor(profile.vendorType, rules);
    return {
      required: isRequired(profile.vendorType, rules), vendorType: profile.vendorType, monthlyPrice: monthly,
      options: SUBSCRIPTION_MONTHS.map((m) => ({ months: m, amount: monthly * m })),
      state: st.state, ok: st.ok, paidUntil: st.paidUntil, graceEnds: st.graceEnds ?? null, daysLeft: st.daysLeft ?? null,
      graceDays: Number(rules.subscriptionGraceDays ?? 0), verified: profile.verification === 'verified',
    };
  };

  async function status(vendorId) {
    const profile = await subscriptionsModel.profile(vendorId);
    if (!profile) throw bad(404, 'NOT_FOUND', 'Vendor not found.');
    return { ...describe(profile), history: await subscriptionsModel.history(vendorId) };
  }

  // Used by the gate on the routes that post products and deals.
  async function isActive(vendorId) {
    const profile = await subscriptionsModel.profile(vendorId);
    if (!profile) return false;
    return stateOf({ vendorType: profile.vendorType, paidUntil: profile.paidUntil }, rules, now()).ok;
  }

  async function start(vendor, months = 1) {
    if (!SUBSCRIPTION_MONTHS.includes(months)) throw bad(400, 'VALIDATION_ERROR', 'Choose 1, 3, 6 or 12 months.');
    const profile = await subscriptionsModel.profile(vendor.id);
    if (!profile) throw bad(404, 'NOT_FOUND', 'Vendor not found.');
    if (profile.verification !== 'verified') throw bad(409, 'VENDOR_NOT_VERIFIED', 'You can subscribe once your account has been verified.');
    const monthly = priceFor(profile.vendorType, rules);
    if (!(monthly > 0)) throw bad(409, 'NO_FEE_DUE', 'There is no subscription to pay for your account type right now.');
    const amount = monthly * months;
    const payment = await subscriptionsModel.createPayment({ vendorId: vendor.id, reference: `${SUB_REF_PREFIX}${randomCode(10)}`, amount, months });
    try {
      const init = await paystack.initialize({
        email: vendor.email, amountKobo: Math.round(payment.amount * 100), reference: payment.reference, callbackUrl: config.callbackUrl,
        metadata: { type: 'vendor_subscription', vendorId: vendor.id, months }, mockPath: '/vendor/subscription/mock',
      });
      await subscriptionsModel.setAuth(payment.id, { url: init.authorizationUrl, accessCode: init.accessCode });
      return { reference: payment.reference, authorizationUrl: init.authorizationUrl, amount: payment.amount, months };
    } catch (err) {
      await subscriptionsModel.fail(payment.id);
      console.error('[subscription] could not start payment:', err.message);
      throw bad(502, 'PAYMENT_UNAVAILABLE', 'We could not start the payment. Please try again in a moment.');
    }
  }

  // The single place a subscription payment is counted (return page and webhook both come here).
  async function handleResult({ reference, status: outcome, amountKobo = null, currency = null }) {
    const payment = await subscriptionsModel.find(reference);
    if (!payment) return { settled: false, ignored: 'unknown_reference' };
    if (payment.status === 'success') return { settled: true, replay: true };
    if (outcome !== 'success') {
      if (outcome === 'failed') await subscriptionsModel.fail(payment.id);
      return { settled: false, status: outcome };
    }
    if ((amountKobo != null && amountKobo !== Math.round(payment.amount * 100)) || (currency != null && currency !== 'NGN')) {
      if (notifier) await notifier.notify('payment_problem', { order: { publicRef: `vendor ${payment.vendorId}` }, reference, reason: 'A subscription payment did not match the price (amount or currency). The subscription was NOT extended.' });
      return { settled: false, mismatch: true };
    }
    const res = await subscriptionsModel.settle({ paymentId: payment.id, vendorId: payment.vendorId, days: payment.months * SUBSCRIPTION_PERIOD_DAYS, paidAt: now() });
    if (res.replay) return { settled: true, replay: true };
    if (notifier) {
      const profile = await subscriptionsModel.profile(payment.vendorId);
      if (profile) await notifier.notify('subscription_paid', { vendor: { email: profile.email, fullName: profile.contactName, companyName: profile.companyName }, amount: payment.amount, months: payment.months, paidUntil: res.paidUntil });
    }
    return { settled: true };
  }

  async function verifyAndSettle(vendor, reference) {
    const payment = await subscriptionsModel.find(reference);
    if (!payment || payment.vendorId !== vendor.id) throw bad(404, 'NOT_FOUND', 'Payment not found.');
    if (payment.status === 'success') return { status: 'paid' };
    let v;
    try {
      v = await paystack.verify(reference);
    } catch (err) {
      console.error('[subscription] verify failed:', err.message);
      throw bad(502, 'PAYMENT_UNAVAILABLE', 'We could not confirm the payment yet. If you were charged, your subscription will update shortly.');
    }
    const r = await handleResult({ reference, status: v.status, amountKobo: v.amountKobo ?? null, currency: v.currency ?? null });
    return { status: r.settled ? 'paid' : v.status === 'failed' ? 'failed' : 'pending' };
  }

  async function mockPay(vendor, reference) {
    if (!paystack.mock) throw bad(404, 'NOT_FOUND', 'Not found.');
    const payment = await subscriptionsModel.find(reference);
    if (!payment || payment.vendorId !== vendor.id) throw bad(404, 'NOT_FOUND', 'Payment not found.');
    paystack.markMockPaid(reference);
    return verifyAndSettle(vendor, reference);
  }

  async function handleWebhook(body) {
    const data = body?.data ?? {};
    if (!data.reference) return { ignored: true };
    if (body.event === 'charge.success') return handleResult({ reference: data.reference, status: data.status === 'success' ? 'success' : data.status, amountKobo: data.amount, currency: data.currency });
    if (body.event === 'charge.failed') return handleResult({ reference: data.reference, status: 'failed' });
    return { ignored: true };
  }

  // ---- admin ----
  async function adminList() {
    const rows = await subscriptionsModel.listForAdmin();
    return {
      prices: { seller: priceFor('seller', rules), company: priceFor('company', rules), graceDays: Number(rules.subscriptionGraceDays ?? 0) },
      vendors: rows.map((r) => {
        const st = stateOf({ vendorType: r.vendorType, paidUntil: r.paidUntil }, rules, now());
        return { ...r, state: st.state, daysLeft: st.daysLeft ?? null, graceEnds: st.graceEnds ?? null };
      }),
    };
  }
  async function adminGrant(adminId, vendorId, days) {
    const until = await subscriptionsModel.grant(vendorId, days, now());
    if (!until) throw bad(404, 'NOT_FOUND', 'Vendor not found.');
    if (auditModel) await auditModel.add({ adminId, action: 'subscription.grant', target: `user:${vendorId}`, detail: { days, until } });
    return { vendorId, paidUntil: until };
  }
  async function adminGrantAll(adminId, days, vendorType = null) {
    const r = await subscriptionsModel.grantAll(days, now(), vendorType);
    if (auditModel) await auditModel.add({ adminId, action: 'subscription.grant_all', target: 'vendors', detail: { days, vendorType, updated: r.updated } });
    return r;
  }

  // Run from the housekeeping timer: one reminder a few days before it runs out, one when the listing goes (after the grace period).
  async function housekeeping() {
    if (!notifier) return { reminded: 0, lapsed: 0 };
    const t = now();
    let reminded = 0;
    let lapsed = 0;
    const soon = await subscriptionsModel.dueBetween(t, new Date(t.getTime() + 3 * DAY));
    for (const v of soon) {
      if (!isRequired(v.vendorType, rules)) continue;
      await notifier.notify('subscription_due', { vendor: v, paidUntil: v.paidUntil, amount: priceFor(v.vendorType, rules) });
      await subscriptionsModel.markReminded(v.vendorId, v.paidUntil);
      reminded += 1;
    }
    const grace = Number(rules.subscriptionGraceDays ?? 0);
    const gone = await subscriptionsModel.lapsedBetween(new Date(t.getTime() - 365 * DAY), new Date(t.getTime() - grace * DAY));
    for (const v of gone) {
      if (!isRequired(v.vendorType, rules)) continue;
      await notifier.notify('subscription_lapsed', { vendor: v, paidUntil: v.paidUntil, amount: priceFor(v.vendorType, rules) });
      await subscriptionsModel.markLapsedNotified(v.vendorId, v.paidUntil);
      lapsed += 1;
    }
    return { reminded, lapsed };
  }

  return { status, isActive, start, handleResult, verifyAndSettle, mockPay, handleWebhook, adminList, adminGrant, adminGrantAll, housekeeping };
}
