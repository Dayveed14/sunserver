import crypto from 'node:crypto';
import { HttpError } from '../lib/httpError.js';
import { findArea, stateName } from '../utils/areas.js';
import { sniffImage, MAX_IMAGE_BYTES } from '../utils/images.js';
import { INSTALL_BANDS, MAX_INSTALL_PHOTOS, installQuote } from '../utils/installRules.js';
import { distanceBetween, rankTechnicians } from '../utils/repairRules.js';

export const INSTALL_REF_PREFIX = 'IP-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const bad = (status, c, message) => new HttpError(status, c, message);
const notFound = () => bad(404, 'NOT_FOUND', 'Not found.');
const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;

// What the customer's timeline shows. Matching steps (recommended, offered, declined…) are our business, not theirs.
const CUSTOMER_EVENTS = {
  quoted: 'Request created', paid: 'Payment received', accepted: 'Installer assigned', on_the_way: 'Installer is on the way', arrived: 'Installer arrived', started: 'Installation started',
  installer_done: 'Installation finished: please check and confirm', confirmed: 'You confirmed the installation', auto_closed: 'Closed automatically (no reply in time)',
  admin_confirmed: 'Closed by TerraVoltix', problem_reported: 'You reported a problem', reviewed: 'You left a review', cancelled: 'Cancelled',
};
// Customers may not change anything about the site pictures; installers add them while on site or building.
const BEFORE_OPEN = ['on_site', 'in_progress'];
const AFTER_OPEN = ['in_progress'];

// Installation requests. A customer describes the job, gets a price from the size bands and pays it. The system ranks the
// approved installers (same state, within their travel distance, by distance, record, rating, experience and response time)
// and recommends the best to the admin, who approves, declines or picks another; with no admin action the recommendation is
// approved after a set time. The approved installer is offered the job; a decline or silence moves to the next and tells the
// admin. After accepting (and confirming they can make the date) the installer sees the address, sets off, arrives, takes
// "before" pictures, builds, takes "after" pictures and sends the completion report. The customer confirms (or it closes by
// itself, or they report a problem), the installer's share becomes owed and the customer can leave a review. Payments follow
// the same rules as orders: counted once, wrong amount held, price fixed at quote time.
export function createInstallationsService({ model, paystack, notifier, usersModel, cloudinary, rules, config, now = () => new Date() }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const place = (r) => `${findArea(r.state, r.areaId)?.name ?? r.areaId}, ${stateName(r.state) ?? r.state}`;
  const todayLagos = () => new Date(now().getTime() + HOUR).toISOString().slice(0, 10);
  const adminDue = () => new Date(now().getTime() + rules.adminMinutes * MINUTE);
  const techDue = () => new Date(now().getTime() + rules.installerMinutes * MINUTE);
  const noShowAt = (r) => new Date(new Date(r.onTheWayAt ?? r.assignedAt).getTime() + rules.noShowHours * HOUR);
  const person = async (id) => { const u = id ? await usersModel.findById(id) : null; return u ? { id: Number(u.id), name: u.full_name, fullName: u.full_name, email: u.email, phone: u.phone } : null; };
  const who = (u) => ({ email: u?.email, fullName: u?.full_name });

  // A short description of the job for emails and the admin.
  const brief = (r) => ({ ref: r.ref, description: r.description, systemKw: r.systemKw, bandLabel: r.bandLabel, pay: r.installerPayout, preferredDate: r.preferredDate, area: place(r), price: r.price, distanceKm: undefined });

  async function work(r, { forInstaller = false } = {}) {
    const [done, before, after, review] = await Promise.all([model.completion(r.id), model.photos(r.id, 'before'), model.photos(r.id, 'after'), model.review(r.id)]);
    const base = {
      completion: done ? { summary: done.summary, at: done.at } : null, beforePhotos: before.map((p) => p.id), afterPhotos: after.map((p) => p.id),
      problem: r.problemAt ? { at: r.problemAt, note: r.problemNote } : null, review,
    };
    return forInstaller ? { ...base, payoutStatus: r.payoutStatus, payoutAmount: r.payoutAmount } : base;
  }

  // What the customer sees. The installer's name and phone appear only once the job is assigned.
  async function customerView(r, { installer = null, payment = null, timeline = null, full = false } = {}) {
    const base = {
      ref: r.ref, status: r.status, description: r.description, systemKw: r.systemKw, bandLabel: r.bandLabel, price: r.price,
      preferredDate: r.preferredDate, address: { line: r.addressLine, state: r.state, areaId: r.areaId, place: place(r) },
      createdAt: r.createdAt, assignedAt: r.assignedAt, installerDoneAt: r.installerDoneAt, completedAt: r.completedAt,
      autoCloseAt: r.status === 'installer_done' && !r.problemAt ? new Date(new Date(r.installerDoneAt).getTime() + rules.autoCloseHours * HOUR).toISOString() : null,
      refund: r.status === 'cancelled' ? { amount: r.refundAmount, pending: r.refundNeeded } : null,
      installer, payment, timeline,
    };
    if (!full) return base;
    return {
      ...base, work: ['in_progress', 'installer_done', 'completed'].includes(r.status) || r.status === 'on_site' ? await work(r) : null,
      canCancel: ['quote', 'awaiting_payment', 'finding', 'assigned', 'on_the_way'].includes(r.status),
      noShowAfter: ['assigned', 'on_the_way'].includes(r.status) ? noShowAt(r) : null,
    };
  }
  async function installerContact(r) {
    if (!r.installerId || !['assigned', 'on_the_way', 'on_site', 'in_progress', 'installer_done', 'completed'].includes(r.status)) return null;
    const u = await usersModel.findById(r.installerId);
    return u ? { name: u.full_name, phone: u.phone } : null;
  }

  // What an installer sees BEFORE accepting: the job and the pay, never the street address or the customer's contact.
  const offerView = (r) => ({
    ref: r.ref, description: r.description, systemKw: r.systemKw, bandLabel: r.bandLabel, pay: r.installerPayout,
    preferredDate: r.preferredDate, area: place(r), sentAt: r.openAt, ...(r.techDueAt ? { answerBy: r.techDueAt } : {}),
  });
  // After accepting: everything needed to do the job.
  async function jobView(r) {
    return {
      ...offerView(r), status: r.status, address: `${r.addressLine}, ${place(r)}`, customer: { name: r.contactName, phone: r.contactPhone },
      assignedAt: r.assignedAt, onTheWayAt: r.onTheWayAt, arrivedAt: r.arrivedAt, startedAt: r.startedAt, installerDoneAt: r.installerDoneAt, completedAt: r.completedAt,
      payoutStatus: r.payoutStatus, payoutAmount: r.payoutAmount, work: await work(r, { forInstaller: true }),
    };
  }

  async function storePhoto(requestId, uploaderId, kind, body) {
    const mime = sniffImage(body);
    if (!mime) throw bad(400, 'INVALID_IMAGE', 'Upload a JPEG, PNG or WebP picture.');
    if (body.length > MAX_IMAGE_BYTES) throw bad(413, 'IMAGE_TOO_LARGE', 'That picture is too large.');
    let remote = null;
    if (cloudinary?.enabled) {
      try { remote = await cloudinary.upload(body, mime, `solalium/installs/${crypto.randomBytes(12).toString('hex')}`); } catch (err) {
        console.error('[install] Cloudinary upload failed:', err.message);
        throw bad(502, 'UPLOAD_FAILED', 'We could not save that picture. Please try again.');
      }
    }
    return model.addPhoto({ requestId, uploaderId, kind, mime, size: body.length, data: body, remote });
  }

  // ---------- matching ----------
  const ranking = async (job) => rankTechnicians(job, await model.candidates());

  async function startMatching(request) {
    const ranked = await ranking(request);
    const queued = await model.startMatching(request.id, ranked, adminDue());
    if (queued === 0) {
      await model.addEvent(request.id, 'no_installers', 'system');
      await notifier.notify('install_unfilled', { request, reason: 'No installer is available for this job (none in range, or all are full).' });
      await model.markAlerted(request.id, now());
      return { queued: 0 };
    }
    await model.addEvent(request.id, 'recommended', 'system');
    const m = await model.currentMatch(request.id, ['recommended']);
    await notifier.notify('install_recommend', { request, match: m, minutes: rules.adminMinutes, installer: await person(m?.installerId) });
    return { queued };
  }
  async function advance(request, why) {
    const next = await model.promoteNext(request.id, adminDue());
    if (!next) {
      await model.addEvent(request.id, 'list_used_up', 'system');
      await notifier.notify('install_unfilled', { request, reason: `${why} There is nobody left on the ranked list. Choose an installer by hand or cancel and refund.` });
      await model.markAlerted(request.id, now());
      return null;
    }
    await model.addEvent(request.id, 'recommended', 'system');
    await notifier.notify('install_recommend', { request, match: next, minutes: rules.adminMinutes, why, installer: await person(next.installerId) });
    return next;
  }
  async function offer(request, match, by) {
    if (!(await model.moveMatch(match.id, 'recommended', 'offered', { techDueAt: techDue(), decidedBy: by }))) return false;
    await model.addEvent(request.id, by === 'auto' ? 'auto_approved' : 'approved', by === 'auto' ? 'system' : 'admin');
    const fresh = await model.findById(request.id);
    await notifier.notify('install_new_job', { request: fresh, installer: await person(match.installerId), offer: offerView(fresh), minutes: rules.installerMinutes });
    return true;
  }

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
      const events = await model.events(r.id);
      return customerView(r, {
        installer: await installerContact(r), full: true,
        payment: pay?.status === 'initiated' ? { reference: pay.reference, authorizationUrl: pay.authorizationUrl } : null,
        timeline: events.filter((e) => CUSTOMER_EVENTS[e.type]).map((e) => ({ type: e.type, text: CUSTOMER_EVENTS[e.type], at: e.at, note: e.type === 'cancelled' ? e.note : null })),
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
      const fresh = await model.findById(payment.requestId);
      const customer = await usersModel.findById(fresh.customerId);
      await notifier.notify('install_paid', { request: fresh, customer: who(customer) });
      await startMatching(fresh);
      return { settled: true };
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

    // Before paying: nothing to refund. Paid and the installer is not on the way: full refund. On the way: half (the installer
    // is paid their share of what is kept). Once the installer has arrived the customer talks to us instead (the admin can cancel).
    async cancel(user, ref) {
      const r = await ownedByCustomer(user, ref);
      const full = ['finding', 'assigned'].includes(r.status);
      const half = r.status === 'on_the_way';
      if (!full && !half && !['quote', 'awaiting_payment'].includes(r.status)) throw bad(409, 'NOT_CANCELLABLE', ['on_site', 'in_progress'].includes(r.status) ? 'The installer is already at your site. Please talk to them, or contact TerraVoltix support to cancel.' : 'This request can no longer be cancelled here.');
      const refundAmount = full ? r.price : half ? Math.round(r.price / 2) : 0;
      const payoutAmount = half ? Math.round((r.price - refundAmount) * rules.payoutPct) : 0;
      const reason = half ? 'Cancelled by the customer after the installer set off (half the fee is refunded)' : 'Cancelled by the customer';
      const ok = await model.cancel({ requestId: r.id, reason, at: now(), refundAmount, from: [r.status], actor: 'customer', payoutAmount });
      if (!ok) throw bad(409, 'NOT_CANCELLABLE', 'This request just changed. Please look again.');
      if (refundAmount > 0) await notifier.notify('install_cancelled', { request: r, reason, refund: refundAmount, customer: who(await usersModel.findById(r.customerId)), installer: await person(r.installerId) });
      return { status: 'cancelled', refund: refundAmount };
    },
    // The installer set off (or was assigned) but has not turned up in time: the customer may cancel for a full refund.
    async noShow(user, ref) {
      const r = await ownedByCustomer(user, ref);
      if (!['assigned', 'on_the_way'].includes(r.status)) throw bad(409, 'NOT_READY', 'This only applies while you are waiting for the installer to arrive.');
      if (now() < noShowAt(r)) throw bad(409, 'TOO_EARLY', `You can report a no-show ${rules.noShowHours} hours after the installer set off. If you cancel before that, only part of the fee is refunded.`);
      const reason = 'The installer did not arrive (full refund)';
      if (!(await model.cancel({ requestId: r.id, reason, at: now(), refundAmount: r.price, from: [r.status], actor: 'customer' }))) throw bad(409, 'NOT_CANCELLABLE', 'This request just changed. Please look again.');
      await model.addEvent(r.id, 'no_show', 'system');
      await notifier.notify('install_cancelled', { request: r, reason, refund: r.price, customer: who(await usersModel.findById(r.customerId)), installer: await person(r.installerId) });
      return { status: 'cancelled', refund: r.price };
    },

    async confirm(user, ref) {
      const r = await ownedByCustomer(user, ref);
      if (r.status === 'completed') return { status: 'completed', already: true };
      if (r.status !== 'installer_done') throw bad(409, 'NOT_READY', 'The installer has not reported the job as finished yet.');
      if (await model.confirm({ requestId: r.id, at: now(), actor: 'customer' })) await this.afterComplete(await model.findById(r.id), false);
      return { status: 'completed' };
    },
    async reportProblem(user, ref, note) {
      const r = await ownedByCustomer(user, ref);
      if (!(await model.reportProblem({ requestId: r.id, note, at: now() }))) throw bad(409, 'NOT_READY', 'You can report a problem once the installer has finished, and only once.');
      await notifier.notify('install_problem', { request: r, note, customer: await person(r.customerId) });
      return { reported: true };
    },
    async review(user, ref, { rating, comment }) {
      const r = await ownedByCustomer(user, ref);
      if (r.status !== 'completed' || !r.installerId) throw bad(409, 'NOT_READY', 'You can review an installation once it is complete.');
      if (!(await model.addReview({ requestId: r.id, customerId: user.id, installerId: r.installerId, rating, comment }))) throw bad(409, 'ALREADY_REVIEWED', 'You already reviewed this installation.');
      await model.addEvent(r.id, 'reviewed', 'customer');
      return { reviewed: true };
    },
    // Customer, assigned installer and admin may see a job's pictures. Everyone else gets "not found".
    async photoFile(requester, ref, id) {
      const r = await model.findByRef(String(ref));
      const allowed = r && (requester.role === 'admin' || r.customerId === requester.id || (r.installerId && r.installerId === requester.id));
      if (!allowed) throw notFound();
      const f = await model.photoFile(r.id, id);
      if (!f) throw notFound();
      return f;
    },

    async afterComplete(request, auto) {
      const customer = await usersModel.findById(request.customerId);
      const installer = request.installerId ? await usersModel.findById(request.installerId) : null;
      await notifier.notify('install_completed', { request, auto, customer: who(customer), installer: installer ? { email: installer.email, fullName: installer.full_name } : null });
    },

    // ---------- installer ----------
    async openJobs(installer) {
      return { jobs: (await model.offersFor(installer.id)).map(offerView) };
    },
    async myJobs(installer) {
      const jobs = await model.jobsFor(installer.id);
      return { jobs: await Promise.all(jobs.map(jobView)), earnings: await model.earnings(installer.id), rating: await model.ratingFor(installer.id) };
    },
    async job(installer, ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (r.installerId === installer.id) return { job: await jobView(r), accepted: true };
      if (r.status === 'finding' && (await model.offerFor(r.id, installer.id))) return { job: offerView(r), accepted: false };
      throw notFound();
    },
    async accept(installer, ref, { confirmAvailable }) {
      if (confirmAvailable !== true) throw bad(400, 'AVAILABILITY_REQUIRED', 'Confirm that you can be at the job on the customer\'s date.');
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (r.installerId === installer.id) return { job: await jobView(r), already: true };
      if (!(await model.offerFor(r.id, installer.id))) throw notFound();
      if (!(await model.accept({ requestId: r.id, installerId: installer.id, at: now() }))) {
        const mine = await model.findById(r.id);
        if (mine?.installerId === installer.id) return { job: await jobView(mine), already: true };
        throw bad(409, 'JOB_TAKEN', 'Sorry, this job is no longer available.');
      }
      const fresh = await model.findById(r.id);
      const customer = await usersModel.findById(fresh.customerId);
      await notifier.notify('install_assigned', { request: fresh, customer: who(customer), installer: { email: installer.email, fullName: installer.fullName, phone: installer.phone }, job: await jobView(fresh) });
      return { job: await jobView(fresh) };
    },
    async decline(installer, ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const m = await model.offerFor(r.id, installer.id);
      if (!m) throw notFound();
      if (!(await model.moveMatch(m.id, 'offered', 'declined'))) throw bad(409, 'JOB_TAKEN', 'Sorry, this job is no longer available.');
      await model.addEvent(r.id, 'declined', 'installer');
      await advance(r, `${installer.fullName} declined the job.`);
      return { declined: true };
    },
    async onMyWay(installer, ref) {
      const r = await ownedJob(installer, ref);
      if (r.status === 'on_the_way') return { status: 'on_the_way', already: true };
      if (!(await model.step({ requestId: r.id, installerId: installer.id, from: 'assigned', to: 'on_the_way', column: 'on_the_way_at', at: now(), event: 'on_the_way' }))) throw bad(409, 'NOT_READY', 'You cannot set off for this job right now.');
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('install_on_the_way', { request: r, customer: who(customer), installer: { fullName: installer.fullName, phone: installer.phone } });
      return { status: 'on_the_way' };
    },
    async arrived(installer, ref) {
      const r = await ownedJob(installer, ref);
      if (r.status === 'on_site') return { status: 'on_site', already: true };
      if (!(await model.step({ requestId: r.id, installerId: installer.id, from: 'on_the_way', to: 'on_site', column: 'arrived_at', at: now(), event: 'arrived' }))) throw bad(409, 'NOT_READY', 'Tap "I\'m on my way" first, then "I have arrived".');
      return { status: 'on_site' };
    },
    // Work begins once "before" pictures of the site are taken.
    async start(installer, ref) {
      const r = await ownedJob(installer, ref);
      if (r.status === 'in_progress') return { status: 'in_progress', already: true };
      if (r.status !== 'on_site') throw bad(409, 'NOT_READY', 'Tap "I have arrived" first.');
      if ((await model.photos(r.id, 'before')).length === 0) throw bad(400, 'PHOTO_REQUIRED', 'Take at least one "before" picture of the site first.');
      if (!(await model.step({ requestId: r.id, installerId: installer.id, from: 'on_site', to: 'in_progress', column: 'started_at', at: now(), event: 'started' }))) throw bad(409, 'NOT_READY', 'You cannot start this job right now.');
      return { status: 'in_progress' };
    },
    async addPhoto(installer, ref, kind, body) {
      const r = await ownedJob(installer, ref);
      if (!(kind === 'before' ? BEFORE_OPEN : AFTER_OPEN).includes(r.status)) throw bad(409, 'PHOTOS_CLOSED', kind === 'before' ? 'Add "before" pictures while you are at the site, before you finish.' : 'Add "after" pictures while the installation is in progress.');
      if ((await model.photos(r.id, kind)).length >= MAX_INSTALL_PHOTOS) throw bad(409, 'TOO_MANY_PHOTOS', `You can add up to ${MAX_INSTALL_PHOTOS} pictures.`);
      return { id: await storePhoto(r.id, installer.id, kind, body) };
    },
    async removePhoto(installer, ref, id) {
      const r = await ownedJob(installer, ref);
      if (!BEFORE_OPEN.includes(r.status)) throw bad(409, 'PHOTOS_CLOSED', 'Pictures can no longer be changed.');
      if (!(await model.removePhoto(r.id, id, installer.id))) throw notFound();
      return { removed: true };
    },
    // The completion report: what was done, with before and after pictures.
    async complete(installer, ref, summary) {
      const r = await ownedJob(installer, ref);
      if (r.status === 'installer_done') throw bad(409, 'ALREADY_REPORTED', 'You already reported this job as finished.');
      if (r.status !== 'in_progress') throw bad(409, 'NOT_READY', 'Start the installation before you report it as finished.');
      if ((await model.photos(r.id, 'after')).length === 0) throw bad(400, 'PHOTO_REQUIRED', 'Add at least one "after" picture of the finished installation.');
      if (!(await model.complete({ requestId: r.id, installerId: installer.id, summary, at: now() }))) throw bad(409, 'NOT_READY', 'This job cannot be reported as finished right now.');
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('install_done', { request: r, customer: who(customer), hours: rules.autoCloseHours });
      return { status: 'installer_done' };
    },

    // ---------- admin ----------
    async adminList({ status, needsAction }) {
      return { requests: await model.listForAdmin({ status, needsAction }), stats: await model.adminStats() };
    },
    async adminGet(ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const [customer, installer, matches, events, photos, w] = await Promise.all([person(r.customerId), person(r.installerId), model.matches(r.id), model.events(r.id), model.photos(r.id), work(r, { forInstaller: true })]);
      const choices = r.status === 'finding' ? (await ranking(r)).map((c) => ({ id: c.id, name: c.fullName, score: c.score, distanceKm: c.distanceKm, atCapacity: c.atCapacity, activeJobs: c.activeJobs, completedJobs: c.completedJobs })) : [];
      return {
        request: { ...r, place: place(r), customer: customer && { name: customer.name, email: customer.email, phone: customer.phone }, installer: installer && { name: installer.name, email: installer.email, phone: installer.phone } },
        matches, timeline: events, photos: photos.map((p) => ({ id: p.id, kind: p.kind })), work: w, choices, adminMinutes: rules.adminMinutes,
      };
    },
    async approve(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const m = await model.currentMatch(r.id, ['recommended']);
      if (!m || r.status !== 'finding') throw bad(409, 'NOTHING_TO_APPROVE', 'There is no recommendation waiting for you on this request.');
      if (!(await offer(r, m, `admin:${adminId}`))) throw bad(409, 'NOTHING_TO_APPROVE', 'This recommendation was just handled.');
      await audit({ adminId, action: 'install.approve', target: `install:${r.ref}`, detail: { installerId: m.installerId } });
      return { offeredTo: m.installerId };
    },
    async declineRecommendation(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const m = await model.currentMatch(r.id, ['recommended']);
      if (!m || r.status !== 'finding') throw bad(409, 'NOTHING_TO_DECLINE', 'There is no recommendation waiting for you on this request.');
      if (!(await model.moveMatch(m.id, 'recommended', 'passed', { decidedBy: `admin:${adminId}` }))) throw bad(409, 'NOTHING_TO_DECLINE', 'This recommendation was just handled.');
      await model.addEvent(r.id, 'passed', 'admin');
      await audit({ adminId, action: 'install.decline_recommendation', target: `install:${r.ref}`, detail: { installerId: m.installerId } });
      const next = await advance(r, 'You declined the recommendation.');
      return { next: next ? next.installerId : null };
    },
    async assign(adminId, ref, installerId, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (r.status !== 'finding') throw bad(409, 'NOT_MATCHING', 'This request is not looking for an installer.');
      let pick = (await ranking(r)).find((c) => c.id === installerId);
      if (!pick) {
        const any = (await model.candidates()).find((c) => c.id === installerId);
        if (!any) throw bad(404, 'NOT_FOUND', 'That installer is not available.');
        pick = { ...any, score: 0, distanceKm: distanceBetween(r, any) ?? 0 };
      }
      if (!(await model.offerTo({ requestId: r.id, installer: pick.id, rankNo: 0, score: pick.score, distanceKm: pick.distanceKm, techDueAt: techDue(), adminId }))) throw bad(409, 'NOT_MATCHING', 'This request just changed. Please look again.');
      await model.addEvent(r.id, 'assigned_by_admin', 'admin');
      await notifier.notify('install_new_job', { request: r, installer: await person(pick.id), offer: offerView(r), minutes: rules.installerMinutes });
      await audit({ adminId, action: 'install.assign', target: `install:${r.ref}`, detail: { installerId: pick.id } });
      return { offeredTo: pick.id };
    },
    // The admin cancels a paid job (nobody took it, or something went wrong); the customer is refunded by hand. Everything paid goes back.
    async adminCancel(adminId, ref, reason, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const from = ['finding', 'assigned', 'on_the_way', 'on_site', 'in_progress', 'installer_done'];
      if (!from.includes(r.status)) throw bad(409, 'NOT_CANCELLABLE', 'This request cannot be cancelled now.');
      if (!(await model.cancel({ requestId: r.id, reason, at: now(), refundAmount: r.price, from: [r.status], actor: 'admin' }))) throw bad(409, 'NOT_CANCELLABLE', 'This request cannot be cancelled now.');
      await audit({ adminId, action: 'install.cancel', target: `install:${r.ref}`, detail: { reason, refund: r.price } });
      await notifier.notify('install_cancelled', { request: r, reason, refund: r.price, customer: who(await usersModel.findById(r.customerId)), installer: await person(r.installerId) });
      return { status: 'cancelled' };
    },
    // The admin closes a finished job for the customer (after a reported problem was sorted out).
    async adminConfirm(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (!(await model.confirm({ requestId: r.id, at: now(), actor: 'admin' }))) throw bad(409, 'NOT_READY', 'This job is not waiting to be closed.');
      await audit({ adminId, action: 'install.confirm', target: `install:${r.ref}`, detail: { payout: r.installerPayout } });
      await this.afterComplete(await model.findById(r.id), false);
      return { status: 'completed' };
    },
    async adminPayoutPaid(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (!(await model.markPayoutPaid(r.id, now()))) throw bad(409, 'NOTHING_OWED', 'There is no payout owed on this job.');
      await model.addEvent(r.id, 'payout_paid', 'admin');
      await audit({ adminId, action: 'install.payout', target: `install:${r.ref}`, detail: { amount: r.payoutAmount } });
      return { payoutStatus: 'paid' };
    },
    async adminRefunded(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (!(await model.markRefunded(r.id))) throw bad(409, 'NO_REFUND_DUE', 'No refund is pending on this job.');
      await audit({ adminId, action: 'install.refund', target: `install:${r.ref}`, detail: { amount: r.refundAmount } });
      return { refundNeeded: false };
    },

    // Run every few minutes: approve what the admin left alone, move on from installers who stayed silent, alert about jobs nobody
    // is working on, and close finished jobs the customer never confirmed (unless they reported a problem).
    async housekeeping() {
      const t = now();
      let autoApproved = 0;
      for (const m of await model.dueAdmin(t)) {
        const r = await model.findById(m.requestId);
        if (r && (await offer(r, m, 'auto'))) autoApproved += 1;
      }
      let lapsed = 0;
      for (const m of await model.dueInstaller(t)) {
        if (!(await model.moveMatch(m.id, 'offered', 'timed_out'))) continue;
        const r = await model.findById(m.requestId);
        const who2 = await person(m.installerId);
        await model.addEvent(r.id, 'timed_out', 'system');
        await notifier.notify('install_lapsed', { request: r, installer: who2, minutes: rules.installerMinutes });
        await advance(r, `${who2?.name ?? 'The installer'} did not answer in time.`);
        lapsed += 1;
      }
      let alerted = 0;
      for (const r of await model.dueForAlert(new Date(t.getTime() - rules.alertMinutes * MINUTE))) {
        if (await model.markAlerted(r.id, t)) {
          await model.addEvent(r.id, 'sla_alert', 'system');
          await notifier.notify('install_unfilled', { request: r, reason: `Nobody is working on finding an installer for this job after ${rules.alertMinutes} minutes.` });
          alerted += 1;
        }
      }
      let closed = 0;
      for (const id of await model.dueForAutoClose(new Date(t.getTime() - rules.autoCloseHours * HOUR))) {
        if (await model.confirm({ requestId: id, at: t, actor: 'system' })) {
          await this.afterComplete(await model.findById(id), true);
          closed += 1;
        }
      }
      return { autoApproved, lapsed, alerted, closed };
    },
  };

  async function ownedJob(installer, ref) {
    const r = await model.findByRef(String(ref));
    if (!r || r.installerId !== installer.id) throw notFound();
    return r;
  }
}
