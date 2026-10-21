import crypto from 'node:crypto';
import { HttpError } from '../lib/httpError.js';

const bad = (status, code, message) => new HttpError(status, code, message);
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (n) => Array.from(crypto.randomBytes(n), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
export const FEE_REF_PREFIX = 'VF-';

// The one-time fee a new vendor pays to join. Built exactly like order payments (same safety rules): the amount comes
// from the admin's pricing settings, a payment counts once however often it is reported, and a wrong amount is held.
// Whether vendors must pay at all is decided in config/launch.js; nothing here runs unless a vendor's status is 'unpaid'.
export function createRegistrationFeeService({ vendorsModel, paystack, notifier = null, rules, config, now = () => new Date() }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function status(vendorId) {
    const profile = await vendorsModel.getProfile(vendorId);
    const state = profile?.registrationFee ?? 'waived';
    return { required: config.required, status: state, amount: rules.vendorRegistrationFee, mustPay: config.required && state === 'unpaid' };
  }

  // Is this vendor allowed to use the dashboard? Used by the gate on every vendor route.
  async function isActive(vendorId) {
    if (!config.required) return true;
    const profile = await vendorsModel.getProfile(vendorId);
    return (profile?.registrationFee ?? 'waived') !== 'unpaid';
  }

  async function start(vendor) {
    const s = await status(vendor.id);
    if (!s.mustPay) throw bad(409, 'NO_FEE_DUE', 'There is no registration fee to pay on this account.');
    const amount = rules.vendorRegistrationFee;
    if (!(amount > 0)) throw bad(409, 'NO_FEE_DUE', 'There is no registration fee to pay right now.');
    const { payment, created } = await vendorsModel.openFeePayment({ vendorId: vendor.id, reference: `${FEE_REF_PREFIX}${randomCode(10)}`, amount });
    if (!created) {
      for (let i = 0; i < 20; i += 1) {
        const latest = await vendorsModel.latestFeePayment(vendor.id);
        if (latest?.authorizationUrl && latest.status === 'initiated') return { reference: latest.reference, authorizationUrl: latest.authorizationUrl, amount: latest.amount };
        if (latest && latest.status !== 'initiated') return start(vendor);
        await sleep(config.pollMs ?? 300);
      }
      throw bad(503, 'PAYMENT_UNAVAILABLE', 'Your payment is still being set up. Please try again in a moment.');
    }
    try {
      const init = await paystack.initialize({
        email: vendor.email, amountKobo: payment.amount * 100, reference: payment.reference, callbackUrl: config.callbackUrl,
        metadata: { type: 'vendor_registration', vendorId: vendor.id }, mockPath: '/vendor/fee/mock',
      });
      await vendorsModel.setFeePaymentAuth(payment.id, { url: init.authorizationUrl, accessCode: init.accessCode });
      return { reference: payment.reference, authorizationUrl: init.authorizationUrl, amount: payment.amount };
    } catch (err) {
      await vendorsModel.failFeePayment(payment.id);
      console.error('[fee] could not start registration payment:', err.message);
      throw bad(502, 'PAYMENT_UNAVAILABLE', 'We could not start the payment. Please try again in a moment.');
    }
  }

  // The single place a registration payment is counted (return page and webhook both come here).
  async function handleResult({ reference, status: outcome, amountKobo = null, currency = null }) {
    const payment = await vendorsModel.findFeePayment(reference);
    if (!payment) return { settled: false, ignored: 'unknown_reference' };
    if (payment.status === 'success') return { settled: true, replay: true };
    if (outcome !== 'success') {
      if (outcome === 'failed') await vendorsModel.failFeePayment(payment.id);
      return { settled: false, status: outcome };
    }
    if ((amountKobo != null && amountKobo !== Math.round(payment.amount * 100)) || (currency != null && currency !== 'NGN')) {
      if (notifier) await notifier.notify('payment_problem', { order: { publicRef: `vendor ${payment.vendorId}` }, reference, reason: 'A vendor registration payment did not match the fee (amount or currency). The vendor was NOT activated.' });
      return { settled: false, mismatch: true };
    }
    const res = await vendorsModel.settleFeePayment({ paymentId: payment.id, vendorId: payment.vendorId, paidAt: now() });
    if (res.replay) return { settled: true, replay: true };
    if (!res.won && notifier) {
      await notifier.notify('payment_problem', { order: { publicRef: `vendor ${payment.vendorId}` }, reference, reason: 'A registration fee payment arrived for a vendor who had nothing to pay. Refund it.' });
    }
    return { settled: true };
  }

  async function verifyAndSettle(vendor, reference) {
    const payment = await vendorsModel.findFeePayment(reference);
    if (!payment || payment.vendorId !== vendor.id) throw bad(404, 'NOT_FOUND', 'Payment not found.');
    if (payment.status === 'success') return { status: 'paid' };
    let v;
    try {
      v = await paystack.verify(reference);
    } catch (err) {
      console.error('[fee] verify failed:', err.message);
      throw bad(502, 'PAYMENT_UNAVAILABLE', 'We could not confirm the payment yet. If you were charged, your account will activate shortly.');
    }
    const r = await handleResult({ reference, status: v.status, amountKobo: v.amountKobo ?? null, currency: v.currency ?? null });
    return { status: r.settled ? 'paid' : v.status === 'failed' ? 'failed' : 'pending' };
  }

  async function mockPay(vendor, reference) {
    if (!paystack.mock) throw bad(404, 'NOT_FOUND', 'Not found.');
    const payment = await vendorsModel.findFeePayment(reference);
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

  return { status, isActive, start, handleResult, verifyAndSettle, mockPay, handleWebhook };
}
