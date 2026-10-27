import crypto from 'node:crypto';
import { HttpError } from '../lib/httpError.js';
import { findArea, stateName } from '../utils/areas.js';
import { INSTALL_BANDS, installQuote } from '../utils/installRules.js';

export const INSTALL_REF_PREFIX = 'IP-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const bad = (status, c, message) => new HttpError(status, c, message);
const notFound = () => bad(404, 'NOT_FOUND', 'Not found.');
const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;

// Installation requests. A customer describes the job, gets a price from the size bands, pays it, and the job is sent to
// every approved installer in their state. The first to accept (and confirm they can make the date) gets it and only
// then sees the address. The installer marks it done, the customer confirms (or it closes itself), and the installer's
// share becomes owed. Payments follow the same rules as orders: counted once, wrong amount held, price fixed at quote time.
export function createInstallationsService({ model, paystack, notifier, usersModel, rules, config, now = () => new Date() }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const place = (r) => `${findArea(r.state, r.areaId)?.name ?? r.areaId}, ${stateName(r.state) ?? r.state}`;
  const todayLagos = () => new Date(now().getTime() + HOUR).toISOString().slice(0, 10);

  // What the customer sees. The installer's name and phone appear only once the job is assigned.
  async function customerView(r, { installer = null, payment = null, timeline = null } = {}) {
    return {
      ref: r.ref, status: r.status, description: r.description, systemKw: r.systemKw, bandLabel: r.bandLabel, price: r.price,
      preferredDate: r.preferredDate, address: { line: r.addressLine, state: r.state, areaId: r.areaId, place: place(r) },
      createdAt: r.createdAt, assignedAt: r.assignedAt, installerDoneAt: r.installerDoneAt, completedAt: r.completedAt,
      autoCloseAt: r.status === 'installer_done' ? new Date(new Date(r.installerDoneAt).getTime() + rules.autoCloseHours * HOUR).toISOString() : null,
      installer, payment, timeline,
    };
  }
  async function installerContact(r) {
    if (!r.installerId || !['assigned', 'installer_done', 'completed'].includes(r.status)) return null;
    const u = await usersModel.findById(r.installerId);
    return u ? { name: u.full_name, phone: u.phone } : null;
  }

  // What an installer sees BEFORE accepting: the job and the pay, never the street address or the customer's contact.
  const offerView = (r) => ({
    ref: r.ref, description: r.description, systemKw: r.systemKw, bandLabel: r.bandLabel, pay: r.installerPayout,
    preferredDate: r.preferredDate, area: place(r), sentAt: r.openAt,
  });
  // After accepting: everything needed to do the job.
  const jobView = (r) => ({
    ...offerView(r), status: r.status, address: `${r.addressLine}, ${place(r)}`, customer: { name: r.contactName, phone: r.contactPhone },
    assignedAt: r.assignedAt, installerDoneAt: r.installerDoneAt, completedAt: r.completedAt, payoutStatus: r.payoutStatus,
  });

  async function ownedByCustomer(user, ref) {
    const r = await model.findByRef(String(ref));
    if (!r || r.customerId !== user.id) throw notFound();
    return r;
  }

  return {
    bands: () => ({ bands: INSTALL_BANDS.map((b) => ({ id: b.id, label: b.label, maxKw: b.maxKw, price: rules.prices[b.id] })) }),

    // ---------- customer ----------
    async create(user, input) {
      const quote = installQuote(input.systemKw, rules);
      if (!quote) throw bad(400, 'VALIDATION_ERROR', 'We could not price a system of that size. Contact us for very large systems.');
      if (!findArea(input.state, input.areaId)) throw bad(400, 'VALIDATION_ERROR', 'Choose an area in the selected state.');
      if (input.preferredDate < todayLagos()) throw bad(400, 'VALIDATION_ERROR', 'Choose a date from today onward.');
      const ref = `IR-${code(8)}`;
      await model.create({
        ref, customerId: user.id, description: input.description, systemKw: input.systemKw, bandId: quote.bandId, bandLabel: quote.bandLabel,
        price: quote.price, installerPayout: quote.installerPayout, state: input.state, areaId: input.areaId, addressLine: input.line,
        contactName: input.contactName ?? user.fullName, contactPhone: input.contactPhone ?? user.phone ?? '', preferredDate: input.preferredDate,
      });
      return customerView(await model.findByRef(ref));
    },

    async list(user) {
      return { requests: await Promise.all((await model.listForCustomer(user.id)).map((r) => customerView(r))) };
    },

    async get(user, ref) {
      const r = await ownedByCustomer(user, ref);
      const pay = ['quote', 'awaiting_payment'].includes(r.status) ? await model.latestPayment(r.id) : null;
      return customerView(r, {
        installer: await installerContact(r),
        payment: pay?.status === 'initiated' ? { reference: pay.reference, authorizationUrl: pay.authorizationUrl } : null,
        timeline: await model.events(r.id),
      });
    },

    // The customer accepts the quote: a payment is started (once, however many times they tap).
    async pay(user, ref) {
      const r = await ownedByCustomer(user, ref);
      if (!['quote', 'awaiting_payment'].includes(r.status)) throw bad(409, 'NOT_PAYABLE', 'This request is already paid or closed.');
      const { payment, created } = await model.openPayment({ requestId: r.id, reference: `${INSTALL_REF_PREFIX}${code(10)}`, amount: r.price });
      if (!payment) throw bad(409, 'NOT_PAYABLE', 'This request is already paid or closed.');
      if (!created) {
        for (let i = 0; i < 20; i += 1) {
          const latest = await model.latestPayment(r.id);
          if (latest?.authorizationUrl && latest.status === 'initiated') return { reference: latest.reference, authorizationUrl: latest.authorizationUrl, amount: latest.amount };
          if (latest && latest.status !== 'initiated') return this.pay(user, ref);
          await sleep(config.pollMs ?? 300);
        }
        throw bad(503, 'PAYMENT_UNAVAILABLE', 'Your payment is still being set up. Please try again in a moment.');
      }
      try {
        const init = await paystack.initialize({
          email: user.email, amountKobo: payment.amount * 100, reference: payment.reference, callbackUrl: config.callbackUrl,
          metadata: { type: 'installation', requestRef: r.ref }, mockPath: '/installation/mock',
        });
        await model.setPaymentAuth(payment.id, { url: init.authorizationUrl, accessCode: init.accessCode });
        return { reference: payment.reference, authorizationUrl: init.authorizationUrl, amount: payment.amount };
      } catch (err) {
        await model.failPayment(payment.id);
        console.error('[install] could not start payment:', err.message);
        throw bad(502, 'PAYMENT_UNAVAILABLE', 'We could not start the payment. Please try again in a moment.');
      }
    },

    // The single place an installation payment is counted (return page and webhook both end up here).
    async handleResult({ reference, status, amountKobo = null, currency = null }) {
      const payment = await model.findPayment(reference);
      if (!payment) return { settled: false, ignored: 'unknown_reference' };
      if (payment.status === 'success') return { settled: true, replay: true };
      if (status !== 'success') {
        if (status === 'failed') await model.failPayment(payment.id);
        return { settled: false, status };
      }
      const request = await model.findById(payment.requestId);
      if ((amountKobo != null && amountKobo !== payment.amount * 100) || (currency != null && currency !== 'NGN')) {
        await notifier.notify('payment_problem', { order: { publicRef: request?.ref ?? `install ${payment.requestId}` }, reference, reason: 'An installation payment did not match the quoted fee (amount or currency). The job was NOT opened.' });
        return { settled: false, mismatch: true };
      }
      const res = await model.settlePayment({ paymentId: payment.id, requestId: payment.requestId, paidAt: now() });
      if (res.replay) return { settled: true, replay: true };
      if (!res.opened) {
        await notifier.notify('payment_problem', { order: { publicRef: request?.ref ?? `install ${payment.requestId}` }, reference, reason: 'An installation payment arrived for a request that was already paid or cancelled. Refund it.' });
        return { settled: true };
      }
      await this.dispatch(await model.findById(payment.requestId));
      return { settled: true };
    },

    // Sends a paid job to the approved installers in the job's state.
    async dispatch(request) {
      const customer = await usersModel.findById(request.customerId);
      await notifier.notify('install_paid', { request, customer: { email: customer?.email, fullName: customer?.full_name } });
      const installers = await model.eligibleInstallers(request.state);
      if (installers.length === 0) {
        await model.addEvent(request.id, 'no_installers', 'system');
        await notifier.notify('install_unfilled', { request, reason: `There are no approved installers in ${stateName(request.state) ?? request.state}.` });
        await model.markAlerted(request.id, now());
        return { sent: 0 };
      }
      await model.addOffers(request.id, installers.map((i) => i.id));
      await model.addEvent(request.id, 'sent', 'system', `${installers.length} installer(s)`);
      for (const i of installers) await notifier.notify('install_new_job', { request, installer: i, offer: offerView(request) });
      return { sent: installers.length };
    },

    // The customer's browser reports back with the payment reference. Only the person who owns the request can ask.
    async verifyAndSettle(user, reference) {
      const payment = await model.findPayment(String(reference));
      const r = payment ? await model.findById(payment.requestId) : null;
      if (!payment || !r || r.customerId !== user.id) throw notFound();
      if (payment.status === 'success') return { status: 'paid', requestRef: r.ref };
      let v;
      try {
        v = await paystack.verify(reference);
      } catch (err) {
        console.error('[install] verify failed:', err.message);
        throw bad(502, 'PAYMENT_UNAVAILABLE', 'We could not confirm the payment yet. If you were charged, your request will open shortly.');
      }
      const res = await this.handleResult({ reference, status: v.status, amountKobo: v.amountKobo ?? null, currency: v.currency ?? null });
      return { status: res.settled ? 'paid' : v.status === 'failed' ? 'failed' : 'pending', requestRef: r.ref };
    },

    async mockPay(user, reference) {
      if (!paystack.mock) throw notFound();
      const payment = await model.findPayment(String(reference));
      const r = payment ? await model.findById(payment.requestId) : null;
      if (!payment || !r || r.customerId !== user.id) throw notFound();
      paystack.markMockPaid(reference);
      return this.verifyAndSettle(user, reference);
    },

    async handleWebhook(body) {
      const d = body?.data ?? {};
      if (!d.reference) return { ignored: true };
      if (body.event === 'charge.success') return this.handleResult({ reference: d.reference, status: d.status === 'success' ? 'success' : d.status, amountKobo: d.amount, currency: d.currency });
      if (body.event === 'charge.failed') return this.handleResult({ reference: d.reference, status: 'failed' });
      return { ignored: true };
    },

    // Before paying, the customer can walk away. After paying, only the admin cancels (and refunds).
    async cancel(user, ref) {
      const r = await ownedByCustomer(user, ref);
      const ok = await model.cancel({ requestId: r.id, reason: 'Cancelled by the customer', at: now(), refundNeeded: false, from: ['quote', 'awaiting_payment'] });
      if (!ok) throw bad(409, 'NOT_CANCELLABLE', 'This request has been paid for. Contact Solalium support to cancel it.');
      return { status: 'cancelled' };
    },

    async confirm(user, ref) {
      const r = await ownedByCustomer(user, ref);
      if (r.status === 'completed') return { status: 'completed', already: true };
      if (r.status !== 'installer_done') throw bad(409, 'NOT_READY', 'The installer has not marked this job as done yet.');
      if (await model.complete({ requestId: r.id, at: now(), actor: 'customer' })) {
        await this.afterComplete(await model.findById(r.id), false);
      }
      return { status: 'completed' };
    },

    async afterComplete(request, auto) {
      const customer = await usersModel.findById(request.customerId);
      const installer = request.installerId ? await usersModel.findById(request.installerId) : null;
      await notifier.notify('install_completed', {
        request, auto,
        customer: { email: customer?.email, fullName: customer?.full_name },
        installer: installer ? { email: installer.email, fullName: installer.full_name } : null,
      });
    },

    // ---------- installer ----------
    async openJobs(installer) {
      return { jobs: (await model.openOffersFor(installer.id)).map(offerView) };
    },
    async myJobs(installer) {
      return { jobs: (await model.jobsFor(installer.id)).map(jobView), earnings: await model.earnings(installer.id) };
    },
    async job(installer, ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (r.installerId === installer.id) return { job: jobView(r), accepted: true };
      const offer = await model.hasOffer(r.id, installer.id);
      if (offer === 'pending' && r.status === 'open') return { job: offerView(r), accepted: false };
      throw notFound();
    },
    async accept(installer, ref, { confirmAvailable }) {
      if (confirmAvailable !== true) throw bad(400, 'AVAILABILITY_REQUIRED', 'Confirm that you can be at the job on the customer\'s date.');
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const offer = await model.hasOffer(r.id, installer.id);
      if (!offer) throw notFound();
      if (r.installerId === installer.id) return { job: jobView(r), already: true };
      if (offer !== 'pending' || r.status !== 'open') throw bad(409, 'JOB_TAKEN', 'Sorry, this job has already been taken.');
      const res = await model.accept({ requestId: r.id, installerId: installer.id, at: now() });
      if (!res.won) throw bad(409, 'JOB_TAKEN', 'Sorry, this job has already been taken.');
      const fresh = await model.findById(r.id);
      const customer = await usersModel.findById(fresh.customerId);
      await notifier.notify('install_assigned', {
        request: fresh,
        customer: { email: customer?.email, fullName: customer?.full_name },
        installer: { email: installer.email, fullName: installer.fullName, phone: installer.phone },
        job: jobView(fresh),
      });
      return { job: jobView(fresh) };
    },
    async decline(installer, ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (!(await model.hasOffer(r.id, installer.id))) throw notFound();
      const res = await model.decline({ requestId: r.id, installerId: installer.id, at: now() });
      if (res.declined && res.remaining === 0 && r.status === 'open') {
        await notifier.notify('install_unfilled', { request: r, reason: 'Every installer we sent this job to has declined it.' });
        await model.markAlerted(r.id, now());
      }
      return { declined: true };
    },
    async done(installer, ref) {
      const r = await model.findByRef(String(ref));
      if (!r || r.installerId !== installer.id) throw notFound();
      if (r.status === 'installer_done' || r.status === 'completed') return { already: true };
      if (!(await model.markDone({ requestId: r.id, installerId: installer.id, at: now() }))) throw bad(409, 'NOT_READY', 'This job cannot be marked done right now.');
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('install_done', { request: r, customer: { email: customer?.email, fullName: customer?.full_name }, hours: rules.autoCloseHours });
      return { status: 'installer_done' };
    },

    // ---------- admin ----------
    async adminList({ status }) {
      return { requests: await model.listForAdmin({ status }), stats: await model.adminStats() };
    },
    async adminGet(ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const customer = await usersModel.findById(r.customerId);
      const installer = r.installerId ? await usersModel.findById(r.installerId) : null;
      return {
        request: { ...r, customer: { name: customer?.full_name, email: customer?.email, phone: customer?.phone }, installer: installer ? { name: installer.full_name, email: installer.email, phone: installer.phone } : null },
        timeline: await model.events(r.id),
      };
    },
    // The admin cancels a paid job (nobody took it, or something went wrong); the customer is refunded by hand.
    async adminCancel(adminId, ref, reason, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const ok = await model.cancel({ requestId: r.id, reason, at: now(), refundNeeded: true, from: ['open', 'assigned', 'installer_done'] });
      if (!ok) throw bad(409, 'NOT_CANCELLABLE', 'This request cannot be cancelled now.');
      await audit({ adminId, action: 'install.cancel', target: `install:${r.ref}`, detail: { reason } });
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('install_cancelled', { request: r, reason, customer: { email: customer?.email, fullName: customer?.full_name } });
      return { status: 'cancelled' };
    },
    async adminPayoutPaid(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (!(await model.markPayoutPaid(r.id, now()))) throw bad(409, 'NOTHING_OWED', 'There is no payout owed on this job.');
      await model.addEvent(r.id, 'payout_paid', 'admin');
      await audit({ adminId, action: 'install.payout', target: `install:${r.ref}`, detail: { amount: r.installerPayout } });
      return { payoutStatus: 'paid' };
    },
    async adminRefunded(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (!(await model.markRefunded(r.id))) throw bad(409, 'NO_REFUND_DUE', 'No refund is pending on this job.');
      await audit({ adminId, action: 'install.refund', target: `install:${r.ref}`, detail: { amount: r.price } });
      return { refundNeeded: false };
    },

    // Run every few minutes: alert the admin about jobs nobody took, and close finished jobs the customer never confirmed.
    async housekeeping() {
      const t = now();
      let alerted = 0;
      for (const r of await model.dueForAlert(new Date(t.getTime() - rules.alertMinutes * MINUTE))) {
        if (await model.markAlerted(r.id, t)) {
          await model.addEvent(r.id, 'sla_alert', 'system');
          await notifier.notify('install_unfilled', { request: r, reason: `Nobody has accepted this job in ${rules.alertMinutes} minutes.` });
          alerted += 1;
        }
      }
      let closed = 0;
      for (const id of await model.dueForAutoClose(new Date(t.getTime() - rules.autoCloseHours * HOUR))) {
        if (await model.complete({ requestId: id, at: t, actor: 'system' })) {
          await this.afterComplete(await model.findById(id), true);
          closed += 1;
        }
      }
      return { alerted, closed };
    },
  };
}
