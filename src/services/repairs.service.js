import crypto from 'node:crypto';
import { HttpError } from '../lib/httpError.js';
import { findArea, stateName } from '../utils/areas.js';
import { sniffImage, MAX_IMAGE_BYTES } from '../utils/images.js';
import { EQUIPMENT, FAULT_TYPES, FEE_BANDS, MAX_FAULT_PHOTOS, MAX_INSPECTION_PHOTOS, PAY_IN_APP_NOTICE, URGENCY, distanceBetween, feeFor, rankTechnicians, technicianShare } from '../utils/repairRules.js';

export const REPAIR_REF_PREFIX = 'RP-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const bad = (status, c, message) => new HttpError(status, c, message);
const notFound = () => bad(404, 'NOT_FOUND', 'Not found.');
const MINUTE = 60 * 1000;
const label = (list, id) => list.find((x) => x.id === id)?.label ?? id;

// What the customer's timeline shows. Matching steps (recommended, offered, declined…) are our business, not theirs.
const CUSTOMER_EVENTS = { requested: 'Request sent', paid: 'Call-out fee paid', accepted: 'Technician assigned', on_the_way: 'Technician is on the way', arrived: 'Technician arrived: inspection started', inspected: 'Inspection finished: your cost estimate is ready', cancelled: 'Cancelled' };
// Customers may add fault photos until the technician is on the way.
const PHOTO_OPEN = ['quote', 'awaiting_payment', 'finding', 'assigned'];

// Repairs, part A. The customer reports a fault and pays a call-out fee that depends on the distance. The system ranks
// the technicians and recommends the best to the admin, who approves, declines or picks another; with no admin action the
// recommendation is approved after a set time. The approved technician is offered the job; a decline or silence moves to the
// next one and tells the admin. After accepting, the technician goes, inspects and reports; the customer then sees the cost.
export function createRepairsService({ model, paystack, notifier, usersModel, cloudinary, rules, config, now = () => new Date() }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const place = (r) => `${findArea(r.state, r.areaId)?.name ?? r.areaId}, ${stateName(r.state) ?? r.state}`;
  const adminDue = () => new Date(now().getTime() + rules.adminMinutes * MINUTE);
  const techDue = () => new Date(now().getTime() + rules.technicianMinutes * MINUTE);
  const brief = (r) => ({ ref: r.ref, fault: label(FAULT_TYPES, r.faultType), description: r.description, equipment: r.equipment.map((e) => label(EQUIPMENT, e)), urgency: label(URGENCY, r.urgency), urgent: r.urgency === 'urgent', area: place(r), distanceKm: r.distanceKm, fee: r.callOutFee });
  const person = async (id) => { const u = id ? await usersModel.findById(id) : null; return u ? { id: Number(u.id), name: u.full_name, email: u.email, phone: u.phone } : null; };

  async function reportView(r, { forTechnician = false } = {}) {
    if (!['inspected', 'approved', 'in_repair', 'awaiting_parts', 'repair_done', 'completed'].includes(r.status)) return null;
    const rep = await model.report(r.id);
    if (!rep) return null;
    const lines = rep.parts.map((p) => ({ name: p.name, qty: p.qty, unitPrice: p.unitPrice, amount: p.qty * p.unitPrice }));
    const base = { findings: rep.findings, parts: lines, labour: rep.labour, total: rep.total, estimatedHours: rep.estimatedHours, callOutCredit: Math.min(r.callOutFee, rep.total), amountDue: Math.max(0, rep.total - r.callOutFee), photos: (await model.photos(r.id, 'inspection')).map((p) => p.id) };
    return forTechnician ? { ...base, youEarn: technicianShare(rep.total, rules) } : base;
  }

  async function customerView(r, { full = false } = {}) {
    const base = {
      ref: r.ref, status: r.status, fault: label(FAULT_TYPES, r.faultType), faultType: r.faultType, description: r.description,
      equipment: r.equipment, urgency: r.urgency, address: { line: r.addressLine, state: r.state, areaId: r.areaId, place: place(r) },
      callOutFee: r.callOutFee, feeBand: label(FEE_BANDS, r.feeBand), distanceKm: r.distanceKm, createdAt: r.createdAt, payNotice: PAY_IN_APP_NOTICE,
      refund: r.status === 'cancelled' ? { amount: r.refundAmount, pending: r.refundNeeded } : null,
    };
    if (!full) return base;
    const [events, photos, tech, report, payment] = await Promise.all([
      model.events(r.id), model.photos(r.id, 'fault'), ['assigned', 'on_the_way', 'on_site', 'inspected', 'approved', 'in_repair', 'awaiting_parts', 'repair_done', 'completed'].includes(r.status) ? person(r.technicianId) : null,
      reportView(r), ['quote', 'awaiting_payment'].includes(r.status) ? model.latestPayment(r.id) : null,
    ]);
    return {
      ...base, photos: photos.map((p) => p.id), technician: tech ? { name: tech.name, phone: tech.phone } : null, report,
      timeline: events.filter((e) => CUSTOMER_EVENTS[e.type]).map((e) => ({ type: e.type, text: CUSTOMER_EVENTS[e.type], at: e.at, note: e.type === 'cancelled' ? e.note : null })),
      payment: payment?.status === 'initiated' ? { reference: payment.reference, authorizationUrl: payment.authorizationUrl } : null,
    };
  }

  async function owned(user, ref) {
    const r = await model.findByRef(String(ref));
    if (!r || r.customerId !== user.id) throw notFound();
    return r;
  }

  async function storePhoto(requestId, uploaderId, kind, body) {
    const mime = sniffImage(body);
    if (!mime) throw bad(400, 'INVALID_IMAGE', 'Upload a JPEG, PNG or WebP picture.');
    if (body.length > MAX_IMAGE_BYTES) throw bad(413, 'IMAGE_TOO_LARGE', 'That picture is too large.');
    let remote = null;
    if (cloudinary.enabled) {
      try { remote = await cloudinary.upload(body, mime, `solalium/repairs/${crypto.randomBytes(12).toString('hex')}`); } catch (err) {
        console.error('[repairs] Cloudinary upload failed:', err.message);
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
      await model.addEvent(request.id, 'no_technician', 'system');
      await notifier.notify('repair_unfilled', { request: brief(request), reason: 'No technician is available for this job (none in range, or all are full).' });
      return { queued: 0 };
    }
    await model.addEvent(request.id, 'recommended', 'system');
    await notifier.notify('repair_recommend', { request: brief(request), match: (await model.currentMatch(request.id, ['recommended'])), minutes: rules.adminMinutes, technician: await person((await model.currentMatch(request.id, ['recommended']))?.technicianId) });
    return { queued };
  }

  // The next-ranked technician becomes the recommendation, or the admin is told the list has run out.
  async function advance(request, why) {
    const next = await model.promoteNext(request.id, adminDue());
    if (!next) {
      await model.addEvent(request.id, 'list_used_up', 'system');
      await notifier.notify('repair_unfilled', { request: brief(request), reason: `${why} There is nobody left on the ranked list. Choose a technician by hand or cancel and refund.` });
      return null;
    }
    await model.addEvent(request.id, 'recommended', 'system');
    await notifier.notify('repair_recommend', { request: brief(request), match: next, minutes: rules.adminMinutes, why, technician: await person(next.technicianId) });
    return next;
  }

  async function offer(request, match, by) {
    if (!(await model.moveMatch(match.id, 'recommended', 'offered', { techDueAt: techDue(), decidedBy: by }))) return false;
    await model.addEvent(request.id, by === 'auto' ? 'auto_approved' : 'approved', by === 'auto' ? 'system' : 'admin');
    await notifier.notify('repair_offer', { request: brief(request), technician: await person(match.technicianId), minutes: rules.technicianMinutes, earn: technicianShare(request.callOutFee, rules) });
    return true;
  }

  return {
    options: () => ({
      faultTypes: FAULT_TYPES, equipment: EQUIPMENT, urgency: URGENCY, maxPhotos: MAX_FAULT_PHOTOS, payNotice: PAY_IN_APP_NOTICE,
      fees: { bands: FEE_BANDS.map((b) => ({ ...b, fee: rules.fees[b.id], upToKm: rules.bandKm[b.id] ?? null })) },
    }),

    // ---------- customer ----------
    async create(user, input) {
      if (!findArea(input.state, input.areaId)) throw bad(400, 'VALIDATION_ERROR', 'Choose an area in the selected state.');
      const job = { state: input.state, areaId: input.areaId };
      const near = (await ranking(job)).sort((a, b) => a.distanceKm - b.distanceKm)[0];
      if (!near) throw bad(409, 'NO_TECHNICIAN', 'We do not have a technician who can reach your area yet. Please try again soon.');
      const { bandId, fee } = feeFor(near.distanceKm, rules);
      const ref = `RR-${code(8)}`;
      await model.create({
        ref, customerId: user.id, faultType: input.faultType, description: input.description, equipment: input.equipment, urgency: input.urgency,
        state: input.state, areaId: input.areaId, addressLine: input.line, contactName: input.contactName ?? user.fullName, contactPhone: input.contactPhone ?? user.phone ?? '',
        callOutFee: fee, feeBand: bandId, distanceKm: near.distanceKm,
      });
      return customerView(await model.findByRef(ref), { full: true });
    },
    async list(user) { return { requests: await Promise.all((await model.listForCustomer(user.id)).map((r) => customerView(r))) }; },
    async get(user, ref) { return customerView(await owned(user, ref), { full: true }); },

    async addFaultPhoto(user, ref, body) {
      const r = await owned(user, ref);
      if (!PHOTO_OPEN.includes(r.status)) throw bad(409, 'PHOTOS_CLOSED', 'Pictures can no longer be added to this request.');
      if ((await model.photos(r.id, 'fault')).length >= MAX_FAULT_PHOTOS) throw bad(409, 'TOO_MANY_PHOTOS', `You can add up to ${MAX_FAULT_PHOTOS} pictures.`);
      return { id: await storePhoto(r.id, user.id, 'fault', body) };
    },
    async removeFaultPhoto(user, ref, id) {
      const r = await owned(user, ref);
      if (!['quote', 'awaiting_payment'].includes(r.status)) throw bad(409, 'PHOTOS_CLOSED', 'Pictures can no longer be changed.');
      if (!(await model.removePhoto(r.id, id, user.id))) throw notFound();
      return { removed: true };
    },
    // Customer, assigned technician and admin may see a request's pictures. Everyone else gets "not found".
    async photoFile(requester, ref, id) {
      const r = await model.findByRef(String(ref));
      const allowed = r && (requester.role === 'admin' || r.customerId === requester.id || (r.technicianId && r.technicianId === requester.id));
      if (!allowed) throw notFound();
      const f = await model.photoFile(r.id, id);
      if (!f) throw notFound();
      return f;
    },

    // The customer agrees to the call-out fee: a payment starts (once, however many times they tap).
    async pay(user, ref) {
      const r = await owned(user, ref);
      if (!['quote', 'awaiting_payment'].includes(r.status)) throw bad(409, 'NOT_PAYABLE', 'This request is already paid or closed.');
      const { payment, created } = await model.openPayment({ requestId: r.id, reference: `${REPAIR_REF_PREFIX}${code(10)}`, amount: r.callOutFee });
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
        const init = await paystack.initialize({ email: user.email, amountKobo: payment.amount * 100, reference: payment.reference, callbackUrl: config.callbackUrl, metadata: { type: 'repair_call_out', requestRef: r.ref }, mockPath: '/repair/mock' });
        await model.setPaymentAuth(payment.id, { url: init.authorizationUrl, accessCode: init.accessCode });
        return { reference: payment.reference, authorizationUrl: init.authorizationUrl, amount: payment.amount };
      } catch (err) {
        await model.failPayment(payment.id);
        console.error('[repair] could not start payment:', err.message);
        throw bad(502, 'PAYMENT_UNAVAILABLE', 'We could not start the payment. Please try again in a moment.');
      }
    },

    // The single place a repair payment is counted.
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
        await notifier.notify('payment_problem', { order: { publicRef: request?.ref ?? `repair ${payment.requestId}` }, reference, reason: 'A repair payment did not match the call-out fee (amount or currency). The request was NOT opened.' });
        return { settled: false, mismatch: true };
      }
      const res = await model.settlePayment({ paymentId: payment.id, requestId: payment.requestId, paidAt: now() });
      if (res.replay) return { settled: true, replay: true };
      if (!res.opened) {
        await notifier.notify('payment_problem', { order: { publicRef: request?.ref ?? `repair ${payment.requestId}` }, reference, reason: 'A repair payment arrived for a request that was already paid or cancelled. Refund it.' });
        return { settled: true };
      }
      const fresh = await model.findById(payment.requestId);
      const customer = await usersModel.findById(fresh.customerId);
      await notifier.notify('repair_paid', { request: brief(fresh), customer: { email: customer?.email, fullName: customer?.full_name } });
      await startMatching(fresh);
      return { settled: true };
    },
    async verifyAndSettle(user, reference) {
      const payment = await model.findPayment(String(reference));
      const r = payment ? await model.findById(payment.requestId) : null;
      if (!payment || !r || r.customerId !== user.id) throw notFound();
      if (payment.status === 'success') return { status: 'paid', requestRef: r.ref };
      let v;
      try { v = await paystack.verify(reference); } catch (err) {
        console.error('[repair] verify failed:', err.message);
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

    // Before payment: nothing to refund. Paid and the technician is not on the way: full refund. On the way: half.
    // Once the technician has arrived the call-out fee has been used (changing course after the quote is phase 4).
    async cancel(user, ref) {
      const r = await owned(user, ref);
      const full = ['finding', 'assigned'].includes(r.status);
      const half = r.status === 'on_the_way';
      if (!full && !half && !['quote', 'awaiting_payment'].includes(r.status)) throw bad(409, 'NOT_CANCELLABLE', 'The technician has already arrived, so this request can no longer be cancelled here.');
      const refundAmount = full ? r.callOutFee : half ? Math.round(r.callOutFee / 2) : 0;
      const reason = half ? 'Cancelled by the customer after the technician set off (half the call-out fee is refunded)' : 'Cancelled by the customer';
      const ok = await model.cancel({ requestId: r.id, reason, at: now(), refundAmount, from: [r.status], actor: 'customer' });
      if (!ok) throw bad(409, 'NOT_CANCELLABLE', 'This request just changed. Please look again.');
      if (refundAmount > 0) {
        const customer = await usersModel.findById(r.customerId);
        await notifier.notify('repair_cancelled', { request: brief(r), refund: refundAmount, customer: { email: customer?.email, fullName: customer?.full_name }, technician: await person(r.technicianId) });
      }
      return { status: 'cancelled', refund: refundAmount };
    },

    // ---------- technician ----------
    async offers(tech) {
      return { offers: (await model.offersFor(tech.id)).map((r) => ({ ...brief(r), youEarn: technicianShare(r.callOutFee, rules), answerBy: r.techDueAt, photoCount: 0 })) };
    },
    async myJobs(tech) {
      const jobs = await model.jobsFor(tech.id);
      return { jobs: await Promise.all(jobs.map((r) => this.jobView(r, tech))) };
    },
    async jobView(r, tech) {
      const base = { ...brief(r), status: r.status, youEarn: technicianShare(r.callOutFee, rules), assignedAt: r.assignedAt, onTheWayAt: r.onTheWayAt, arrivedAt: r.arrivedAt, inspectedAt: r.inspectedAt };
      if (r.technicianId !== tech.id) return base;
      return {
        ...base, address: `${r.addressLine}, ${place(r)}`, customer: { name: r.contactName, phone: r.contactPhone },
        faultPhotos: (await model.photos(r.id, 'fault')).map((p) => p.id), inspectionPhotos: (await model.photos(r.id, 'inspection')).map((p) => p.id), report: await reportView(r, { forTechnician: true }),
      };
    },
    // An offered job (before accepting) or one of the technician's own. Anything else looks like it does not exist.
    async job(tech, ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (r.technicianId === tech.id) return { job: await this.jobView(r, tech), accepted: true };
      if (r.status === 'finding' && (await model.offerFor(r.id, tech.id))) return { job: { ...brief(r), status: 'offered', youEarn: technicianShare(r.callOutFee, rules), faultPhotoCount: (await model.photos(r.id, 'fault')).length }, accepted: false };
      throw notFound();
    },
    async accept(tech, ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (r.technicianId === tech.id) return { job: await this.jobView(r, tech), already: true };
      if (!(await model.offerFor(r.id, tech.id))) throw notFound();
      if (!(await model.accept({ requestId: r.id, technicianId: tech.id, at: now() }))) {
        // A second tap that arrives together with the first still finds the job theirs.
        const mine = await model.findById(r.id);
        if (mine?.technicianId === tech.id) return { job: await this.jobView(mine, tech), already: true };
        throw bad(409, 'JOB_GONE', 'Sorry, this job is no longer available.');
      }
      const fresh = await model.findById(r.id);
      const customer = await usersModel.findById(fresh.customerId);
      await notifier.notify('repair_assigned', { request: brief(fresh), customer: { email: customer?.email, fullName: customer?.full_name }, technician: { fullName: tech.fullName, phone: tech.phone, email: tech.email } });
      return { job: await this.jobView(fresh, tech) };
    },
    async decline(tech, ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const m = await model.offerFor(r.id, tech.id);
      if (!m) throw notFound();
      if (!(await model.moveMatch(m.id, 'offered', 'declined'))) throw bad(409, 'JOB_GONE', 'Sorry, this job is no longer available.');
      await model.addEvent(r.id, 'declined', 'technician');
      await advance(r, `${tech.fullName} declined the job.`);
      return { declined: true };
    },
    async onMyWay(tech, ref) {
      const r = await ownedJob(tech, ref);
      if (r.status === 'on_the_way') return { status: 'on_the_way', already: true };
      if (!(await model.step({ requestId: r.id, technicianId: tech.id, from: 'assigned', to: 'on_the_way', column: 'on_the_way_at', at: now(), event: 'on_the_way' }))) throw bad(409, 'NOT_READY', 'You cannot set off for this job right now.');
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('repair_on_the_way', { request: brief(r), customer: { email: customer?.email, fullName: customer?.full_name }, technician: { fullName: tech.fullName, phone: tech.phone } });
      return { status: 'on_the_way' };
    },
    async arrived(tech, ref) {
      const r = await ownedJob(tech, ref);
      if (r.status === 'on_site') return { status: 'on_site', already: true };
      if (!(await model.step({ requestId: r.id, technicianId: tech.id, from: 'on_the_way', to: 'on_site', column: 'arrived_at', at: now(), event: 'arrived' }))) throw bad(409, 'NOT_READY', 'Tap "I\'m on my way" first, then "I have arrived".');
      return { status: 'on_site' };
    },
    async addInspectionPhoto(tech, ref, body) {
      const r = await ownedJob(tech, ref);
      if (r.status !== 'on_site') throw bad(409, 'PHOTOS_CLOSED', 'Add inspection pictures while you are at the customer\'s site, before sending the report.');
      if ((await model.photos(r.id, 'inspection')).length >= MAX_INSPECTION_PHOTOS) throw bad(409, 'TOO_MANY_PHOTOS', `You can add up to ${MAX_INSPECTION_PHOTOS} pictures.`);
      return { id: await storePhoto(r.id, tech.id, 'inspection', body) };
    },
    async removeInspectionPhoto(tech, ref, id) {
      const r = await ownedJob(tech, ref);
      if (r.status !== 'on_site') throw bad(409, 'PHOTOS_CLOSED', 'Pictures can no longer be changed.');
      if (!(await model.removePhoto(r.id, id, tech.id))) throw notFound();
      return { removed: true };
    },
    // Findings, parts, labour and a time estimate. The system adds it up; the customer sees the itemised cost.
    async report(tech, ref, input) {
      const r = await ownedJob(tech, ref);
      const partsTotal = input.parts.reduce((s, p) => s + p.qty * p.unitPrice, 0);
      const total = partsTotal + input.labour;
      if (total > 5_000_000) throw bad(400, 'VALIDATION_ERROR', 'That total is more than we can quote here. Contact TerraVoltix support.');
      if (r.status === 'inspected') throw bad(409, 'ALREADY_REPORTED', 'You already sent the report for this job.');
      if (!(await model.saveReport({ requestId: r.id, technicianId: tech.id, findings: input.findings, parts: input.parts, labour: input.labour, estimatedHours: input.estimatedHours, total, at: now() }))) throw bad(409, 'NOT_READY', 'You can send the report once you have arrived at the site.');
      const fresh = await model.findById(r.id);
      const customer = await usersModel.findById(fresh.customerId);
      await notifier.notify('repair_inspected', { request: brief(fresh), customer: { email: customer?.email, fullName: customer?.full_name }, total, due: Math.max(0, total - fresh.callOutFee) });
      return { status: 'inspected', report: await reportView(fresh, { forTechnician: true }) };
    },

    // ---------- admin ----------
    async adminList({ status, needsAction }) { return { requests: await model.listForAdmin({ status, needsAction }), stats: await model.adminStats() }; },
    async adminGet(ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const [customer, technician, matches, events, faultPhotos, report] = await Promise.all([person(r.customerId), person(r.technicianId), model.matches(r.id), model.events(r.id), model.photos(r.id), reportView(r)]);
      // Technicians the admin could pick by hand: every available technician, ranked, including those at capacity.
      const choices = r.status === 'finding' ? (await ranking(r)).map((c) => ({ id: c.id, name: c.fullName, score: c.score, distanceKm: c.distanceKm, atCapacity: c.atCapacity, activeJobs: c.activeJobs, completedJobs: c.completedJobs })) : [];
      return {
        request: { ...r, fault: label(FAULT_TYPES, r.faultType), equipment: r.equipment.map((e) => label(EQUIPMENT, e)), place: place(r), customer, technician },
        matches, timeline: events, photos: faultPhotos.map((p) => ({ id: p.id, kind: p.kind })), report, choices, adminMinutes: rules.adminMinutes,
      };
    },
    // Approve the recommended technician: the job is offered to them.
    async approve(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const m = await model.currentMatch(r.id, ['recommended']);
      if (!m || r.status !== 'finding') throw bad(409, 'NOTHING_TO_APPROVE', 'There is no recommendation waiting for you on this request.');
      if (!(await offer(r, m, `admin:${adminId}`))) throw bad(409, 'NOTHING_TO_APPROVE', 'This recommendation was just handled.');
      await audit({ adminId, action: 'repair.approve', target: `repair:${r.ref}`, detail: { technicianId: m.technicianId } });
      return { offeredTo: m.technicianId };
    },
    // Decline the recommendation: the next-ranked technician is recommended.
    async declineRecommendation(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const m = await model.currentMatch(r.id, ['recommended']);
      if (!m || r.status !== 'finding') throw bad(409, 'NOTHING_TO_DECLINE', 'There is no recommendation waiting for you on this request.');
      if (!(await model.moveMatch(m.id, 'recommended', 'passed', { decidedBy: `admin:${adminId}` }))) throw bad(409, 'NOTHING_TO_DECLINE', 'This recommendation was just handled.');
      await model.addEvent(r.id, 'passed', 'admin');
      await audit({ adminId, action: 'repair.decline_recommendation', target: `repair:${r.ref}`, detail: { technicianId: m.technicianId } });
      const next = await advance(r, 'You declined the recommendation.');
      return { next: next ? next.technicianId : null };
    },
    // Choose another technician: the job is offered straight to them.
    async assign(adminId, ref, technicianId, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (r.status !== 'finding') throw bad(409, 'NOT_MATCHING', 'This request is not looking for a technician.');
      const ranked = await ranking(r);
      let pick = ranked.find((c) => c.id === technicianId);
      if (!pick) {
        const any = (await model.candidates()).find((c) => c.id === technicianId);
        if (!any) throw bad(404, 'NOT_FOUND', 'That technician is not available for repairs.');
        pick = { ...any, score: 0, distanceKm: distanceBetween(r, any) ?? 0 };
      }
      const ok = await model.offerTo({ requestId: r.id, technician: pick.id, rankNo: 0, score: pick.score, distanceKm: pick.distanceKm, techDueAt: techDue(), adminId });
      if (!ok) throw bad(409, 'NOT_MATCHING', 'This request just changed. Please look again.');
      await model.addEvent(r.id, 'assigned_by_admin', 'admin');
      await notifier.notify('repair_offer', { request: brief(r), technician: await person(pick.id), minutes: rules.technicianMinutes, earn: technicianShare(r.callOutFee, rules) });
      await audit({ adminId, action: 'repair.assign', target: `repair:${r.ref}`, detail: { technicianId: pick.id } });
      return { offeredTo: pick.id };
    },
    // The admin cancels a paid request that cannot go ahead: the whole call-out fee is refunded by hand.
    async adminCancel(adminId, ref, reason, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const ok = await model.cancel({ requestId: r.id, reason, at: now(), refundAmount: r.callOutFee, from: ['finding', 'assigned', 'on_the_way', 'on_site'], actor: 'admin' });
      if (!ok) throw bad(409, 'NOT_CANCELLABLE', 'This request cannot be cancelled now.');
      await audit({ adminId, action: 'repair.cancel', target: `repair:${r.ref}`, detail: { reason } });
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('repair_cancelled', { request: brief(r), refund: r.callOutFee, reason, customer: { email: customer?.email, fullName: customer?.full_name }, technician: await person(r.technicianId) });
      return { status: 'cancelled' };
    },
    async adminRefunded(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (!(await model.markRefunded(r.id))) throw bad(409, 'NO_REFUND_DUE', 'No refund is pending on this request.');
      await model.addEvent(r.id, 'refunded', 'admin');
      await audit({ adminId, action: 'repair.refund', target: `repair:${r.ref}`, detail: { amount: r.refundAmount } });
      return { refundNeeded: false };
    },

    // Run every few minutes. An admin who has not acted in time approves the recommendation for them; a technician who
    // has not answered in time loses the offer, the next one is recommended and the admin is told.
    async housekeeping() {
      const t = now();
      let autoApproved = 0;
      for (const m of await model.dueAdmin(t)) {
        const r = await model.findById(m.requestId);
        if (r && (await offer(r, m, 'auto'))) autoApproved += 1;
      }
      let lapsed = 0;
      for (const m of await model.dueTechnician(t)) {
        if (!(await model.moveMatch(m.id, 'offered', 'timed_out'))) continue;
        const r = await model.findById(m.requestId);
        const tech = await person(m.technicianId);
        await model.addEvent(r.id, 'timed_out', 'system');
        await notifier.notify('repair_lapsed', { request: brief(r), technician: tech, minutes: rules.technicianMinutes });
        await advance(r, `${tech?.name ?? 'The technician'} did not answer in time.`);
        lapsed += 1;
      }
      return { autoApproved, lapsed };
    },
  };

  async function ownedJob(tech, ref) {
    const r = await model.findByRef(String(ref));
    if (!r || r.technicianId !== tech.id) throw notFound();
    return r;
  }
}
