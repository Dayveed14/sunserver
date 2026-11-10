import crypto from 'node:crypto';
import { HttpError } from '../lib/httpError.js';
import { findArea, stateName } from '../utils/areas.js';
import { sniffImage, MAX_IMAGE_BYTES } from '../utils/images.js';
import { EQUIPMENT, FAULT_TYPES, FEE_BANDS, MAX_COMPLETION_PHOTOS, MAX_FAULT_PHOTOS, MAX_INSPECTION_PHOTOS, PAY_IN_APP_NOTICE, URGENCY, distanceBetween, feeFor, rankTechnicians, technicianShare } from '../utils/repairRules.js';

export const REPAIR_REF_PREFIX = 'RP-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const bad = (status, c, message) => new HttpError(status, c, message);
const notFound = () => bad(404, 'NOT_FOUND', 'Not found.');
const MINUTE = 60 * 1000;
const label = (list, id) => list.find((x) => x.id === id)?.label ?? id;

// What the customer's timeline shows. Matching steps (recommended, offered, declined…) are our business, not theirs.
const CUSTOMER_EVENTS = { requested: 'Request sent', paid: 'Call-out fee paid', accepted: 'Technician assigned', on_the_way: 'Technician is on the way', arrived: 'Technician arrived: inspection started', inspected: 'Inspection finished: your cost estimate is ready', cancelled: 'Cancelled',
  quote_approved: 'You approved the estimate', quote_declined: 'You did not go ahead with the repair', repair_started: 'Repair started', awaiting_parts: 'Waiting for parts', parts_arrived: 'Parts arrived: repair continues',
  variation_proposed: 'The technician asked to change the estimate', variation_approved: 'You approved the revised estimate', variation_declined: 'You declined the revised estimate', variation_withdrawn: 'The revised estimate was withdrawn',
  repair_done: 'Repair finished: please check and confirm', confirmed: 'You confirmed the repair', auto_confirmed: 'Closed automatically (no reply in time)', admin_confirmed: 'Closed by TerraVoltix', problem_reported: 'You reported a problem' };
const WORK = ['approved', 'in_repair', 'awaiting_parts', 'repair_done', 'completed'];
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

  const lineView = (v) => ({ id: v.id, reason: v.reason, parts: v.parts.map((p) => ({ name: p.name, qty: p.qty, unitPrice: p.unitPrice, amount: p.qty * p.unitPrice })), labour: v.labour, extraTotal: v.extraTotal, status: v.status, at: v.createdAt });
  // The repair itself: agreed price, revisions, the completion note and the customer's review.
  async function workView(r, { forTechnician = false } = {}) {
    if (!WORK.includes(r.status) && !(r.status === 'cancelled' && r.agreedTotal != null)) return null;
    const [vars, done, review, photos] = await Promise.all([model.variations(r.id), model.completion(r.id), model.review(r.id), model.photos(r.id, 'completion')]);
    const base = {
      agreedTotal: r.agreedTotal, paidAmount: r.paidAmount, partsNote: r.partsNote, variations: vars.map(lineView),
      completion: done ? { summary: done.summary, at: done.at, photos: photos.map((p) => p.id) } : null,
      confirmDueAt: r.status === 'repair_done' ? r.confirmDueAt : null, problem: r.problemAt ? { at: r.problemAt, note: r.problemNote } : null, review,
    };
    if (!forTechnician) return base;
    return { ...base, completionPhotos: photos.map((p) => p.id), youEarn: technicianShare(r.agreedTotal ?? 0, rules), payoutStatus: r.payoutStatus, payoutAmount: r.payoutAmount };
  }

  async function customerView(r, { full = false } = {}) {
    const base = {
      ref: r.ref, status: r.status, fault: label(FAULT_TYPES, r.faultType), faultType: r.faultType, description: r.description,
      equipment: r.equipment, urgency: r.urgency, address: { line: r.addressLine, state: r.state, areaId: r.areaId, place: place(r) },
      callOutFee: r.callOutFee, feeBand: label(FEE_BANDS, r.feeBand), distanceKm: r.distanceKm, createdAt: r.createdAt, payNotice: PAY_IN_APP_NOTICE,
      refund: r.status === 'cancelled' ? { amount: r.refundAmount, pending: r.refundNeeded } : null, paidAmount: r.paidAmount,
    };
    if (!full) return base;
    const [events, photos, tech, report, payment] = await Promise.all([
      model.events(r.id), model.photos(r.id, 'fault'), ['assigned', 'on_the_way', 'on_site', 'inspected', 'approved', 'in_repair', 'awaiting_parts', 'repair_done', 'completed'].includes(r.status) || (r.status === 'cancelled' && r.technicianId) ? person(r.technicianId) : null,
      reportView(r), ['quote', 'awaiting_payment'].includes(r.status) ? model.latestPayment(r.id) : null,
    ]);
    const work = await workView(r);
    return {
      ...base, photos: photos.map((p) => p.id), technician: tech ? { name: tech.name, phone: tech.phone } : null, report, work,
      canCancel: ['quote', 'awaiting_payment', 'finding', 'assigned', 'on_the_way', 'approved'].includes(r.status),
      noShowAfter: ['assigned', 'on_the_way'].includes(r.status) ? noShowAt(r) : null,
      timeline: events.filter((e) => CUSTOMER_EVENTS[e.type]).map((e) => ({ type: e.type, text: CUSTOMER_EVENTS[e.type], at: e.at, note: e.type === 'cancelled' ? e.note : null })),
      payment: payment?.status === 'initiated' ? { reference: payment.reference, authorizationUrl: payment.authorizationUrl } : null,
    };
  }

  // A technician who set off but has not arrived by then counts as a no-show.
  const noShowAt = (r) => new Date(new Date(r.onTheWayAt ?? r.assignedAt).getTime() + rules.noShowHours * 60 * MINUTE);

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

  // Starts a payment for the request (one open payment per request and purpose, however many times the customer taps).
  async function begin(user, r, { purpose, amount, variationId = null, metaType }) {
    const { payment, created } = await model.openPayment({ requestId: r.id, reference: `${REPAIR_REF_PREFIX}${code(10)}`, amount, purpose, variationId });
    if (!payment) throw bad(409, 'NOT_PAYABLE', 'This payment is no longer needed or already made.');
    if (!created) {
      for (let i = 0; i < 20; i += 1) {
        const latest = await model.latestPayment(r.id, purpose);
        if (latest?.authorizationUrl && latest.status === 'initiated') return { reference: latest.reference, authorizationUrl: latest.authorizationUrl, amount: latest.amount };
        if (latest && latest.status !== 'initiated') return begin(user, r, { purpose, amount, variationId, metaType });
        await sleep(config.pollMs ?? 300);
      }
      throw bad(503, 'PAYMENT_UNAVAILABLE', 'Your payment is still being set up. Please try again in a moment.');
    }
    try {
      const init = await paystack.initialize({ email: user.email, amountKobo: payment.amount * 100, reference: payment.reference, callbackUrl: config.callbackUrl, metadata: { type: metaType, requestRef: r.ref }, mockPath: '/repair/mock' });
      await model.setPaymentAuth(payment.id, { url: init.authorizationUrl, accessCode: init.accessCode });
      return { reference: payment.reference, authorizationUrl: init.authorizationUrl, amount: payment.amount };
    } catch (err) {
      await model.failPayment(payment.id);
      console.error('[repair] could not start payment:', err.message);
      throw bad(502, 'PAYMENT_UNAVAILABLE', 'We could not start the payment. Please try again in a moment.');
    }
  }

  const problem = (request, payment, reference, reason) => notifier.notify('payment_problem', { order: { publicRef: request?.ref ?? `repair ${payment.requestId}` }, reference, reason });

  // The estimate was paid (or needed no payment): the technician is told to start.
  async function afterApproval(r) {
    await notifier.notify('repair_approved', { request: brief(r), technician: await person(r.technicianId), earn: technicianShare((await model.report(r.id))?.total ?? 0, rules) });
  }

  // Payments for the repair itself (the estimate, or a revision of it). Same safety rules as the call-out fee.
  async function settleLater(payment, request, { amountKobo, currency }) {
    if ((amountKobo != null && amountKobo !== payment.amount * 100) || (currency != null && currency !== 'NGN')) {
      await problem(request, payment, payment.reference, 'A repair payment did not match the amount due (amount or currency). The estimate was NOT approved.');
      return { settled: false, mismatch: true };
    }
    if (payment.purpose === 'repair') {
      const rep = await model.report(payment.requestId);
      const res = await model.settleRepairPayment({ paymentId: payment.id, requestId: payment.requestId, total: rep?.total ?? 0, paidAt: now() });
      if (res.replay) return { settled: true, replay: true };
      if (!res.ok) { await problem(request, payment, payment.reference, 'A repair payment arrived for a request that no longer waits for it (cancelled or already paid). Refund it.'); return { settled: true }; }
      await afterApproval(await model.findById(payment.requestId));
      return { settled: true };
    }
    const v = await model.findVariation(payment.variationId, payment.requestId);
    const res = await model.settleVariationPayment({ paymentId: payment.id, requestId: payment.requestId, variationId: payment.variationId, extra: v?.extraTotal ?? 0, paidAt: now() });
    if (res.replay) return { settled: true, replay: true };
    if (!res.ok) { await problem(request, payment, payment.reference, 'A payment for a revised estimate arrived after it was withdrawn or the repair closed. Refund it.'); return { settled: true }; }
    await notifier.notify('repair_variation_decided', { request: brief(request), technician: await person(request.technicianId), approved: true, extra: v.extraTotal });
    return { settled: true };
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
      return begin(user, r, { purpose: 'call_out', amount: r.callOutFee, metaType: 'repair_call_out' });
    },
    // The customer approves the technician's estimate. The call-out fee is credited; the rest is paid in the app.
    async approveQuote(user, ref) {
      const r = await owned(user, ref);
      const rep = r.status === 'inspected' ? await model.report(r.id) : null;
      if (!rep) throw bad(409, 'NOT_PAYABLE', 'There is no estimate waiting for your approval.');
      const due = Math.max(0, rep.total - r.callOutFee);
      if (due === 0) {
        if (!(await model.approveFree({ requestId: r.id, total: Math.max(rep.total, r.callOutFee), at: now() }))) throw bad(409, 'NOT_PAYABLE', 'This estimate was just handled.');
        await afterApproval(r);
        return { approved: true, due: 0 };
      }
      return begin(user, r, { purpose: 'repair', amount: due, metaType: 'repair_quote' });
    },
    async declineQuote(user, ref) {
      const r = await owned(user, ref);
      if (r.status !== 'inspected') throw bad(409, 'NOT_PAYABLE', 'There is no estimate waiting for your decision.');
      if (!(await model.declineQuote({ requestId: r.id, at: now(), payoutAmount: technicianShare(r.callOutFee, rules) }))) throw bad(409, 'NOT_PAYABLE', 'This estimate was just handled.');
      await notifier.notify('repair_quote_declined', { request: brief(r), technician: await person(r.technicianId), earn: technicianShare(r.callOutFee, rules) });
      return { status: 'cancelled' };
    },
    // A change to the estimate during the repair: the customer approves and pays the extra, or declines (work continues as quoted).
    async approveVariation(user, ref, id) {
      const r = await owned(user, ref);
      const v = await model.findVariation(id, r.id);
      if (!v || v.status !== 'proposed' || !['in_repair', 'awaiting_parts'].includes(r.status)) throw bad(409, 'NOT_PAYABLE', 'There is no revised estimate waiting for you.');
      return begin(user, r, { purpose: 'variation', amount: v.extraTotal, variationId: v.id, metaType: 'repair_variation' });
    },
    async declineVariation(user, ref, id) {
      const r = await owned(user, ref);
      if (!(await model.closeVariation({ id, requestId: r.id, to: 'declined', at: now(), actor: 'customer' }))) throw bad(409, 'NOT_PAYABLE', 'There is no revised estimate waiting for you.');
      await notifier.notify('repair_variation_decided', { request: brief(r), technician: await person(r.technicianId), approved: false });
      return { declined: true };
    },
    async confirm(user, ref) {
      const r = await owned(user, ref);
      if (r.status === 'completed') return { status: 'completed', already: true };
      if (r.status !== 'repair_done') throw bad(409, 'NOT_READY', 'The technician has not reported the repair as finished yet.');
      if (!(await model.confirm({ requestId: r.id, at: now(), actor: 'customer', payoutAmount: technicianShare(r.agreedTotal ?? 0, rules) }))) throw bad(409, 'NOT_READY', 'This repair just changed. Please look again.');
      await notifier.notify('repair_completed', { request: brief(r), technician: await person(r.technicianId), earn: technicianShare(r.agreedTotal ?? 0, rules), auto: false });
      return { status: 'completed' };
    },
    async reportProblem(user, ref, note) {
      const r = await owned(user, ref);
      if (!(await model.reportProblem({ requestId: r.id, note, at: now() }))) throw bad(409, 'NOT_READY', 'You can report a problem once the technician has finished, and only once.');
      await notifier.notify('repair_problem', { request: brief(r), note, customer: await person(r.customerId) });
      return { reported: true };
    },
    async review(user, ref, { rating, comment }) {
      const r = await owned(user, ref);
      if (r.status !== 'completed' || !r.technicianId) throw bad(409, 'NOT_READY', 'You can review a repair once it is complete.');
      if (!(await model.addReview({ requestId: r.id, customerId: user.id, technicianId: r.technicianId, rating, comment }))) throw bad(409, 'ALREADY_REVIEWED', 'You already reviewed this repair.');
      await model.addEvent(r.id, 'reviewed', 'customer');
      return { reviewed: true };
    },
    // The technician set off (or was assigned) but has not turned up in time: the customer may cancel for a full refund.
    async noShow(user, ref) {
      const r = await owned(user, ref);
      if (!['assigned', 'on_the_way'].includes(r.status)) throw bad(409, 'NOT_READY', 'This only applies while you are waiting for the technician to arrive.');
      if (now() < noShowAt(r)) throw bad(409, 'TOO_EARLY', `You can report a no-show ${rules.noShowHours} hours after the technician set off. If you cancel before that, only part of the call-out fee is refunded.`);
      const ok = await model.cancel({ requestId: r.id, reason: 'The technician did not arrive (full refund)', at: now(), refundAmount: r.paidAmount, from: [r.status], actor: 'customer' });
      if (!ok) throw bad(409, 'NOT_CANCELLABLE', 'This request just changed. Please look again.');
      await model.addEvent(r.id, 'no_show', 'system');
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('repair_cancelled', { request: brief(r), refund: r.paidAmount, reason: 'The technician did not arrive', customer: { email: customer?.email, fullName: customer?.full_name }, technician: await person(r.technicianId) });
      return { status: 'cancelled', refund: r.paidAmount };
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
      if (payment.purpose !== 'call_out') return settleLater(payment, request, { amountKobo, currency });
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
      const afterQuote = r.status === 'approved'; // the visit was used: only the repair payment comes back
      if (!full && !half && !afterQuote && !['quote', 'awaiting_payment'].includes(r.status)) throw bad(409, 'NOT_CANCELLABLE', r.status === 'inspected' ? 'Use "No thanks" on the estimate instead.' : ['in_repair', 'awaiting_parts', 'repair_done'].includes(r.status) ? 'The repair has started. If something is wrong, tell us with "Report a problem" or contact support.' : 'This request can no longer be cancelled here.');
      const refundAmount = full ? r.callOutFee : half ? Math.round(r.callOutFee / 2) : afterQuote ? Math.max(0, r.paidAmount - r.callOutFee) : 0;
      const reason = half ? 'Cancelled by the customer after the technician set off (half the call-out fee is refunded)' : afterQuote ? 'Cancelled by the customer before the repair started (the call-out fee is kept; the repair payment is refunded)' : 'Cancelled by the customer';
      const ok = await model.cancel({ requestId: r.id, reason, at: now(), refundAmount, from: [r.status], actor: 'customer', payoutAmount: afterQuote ? technicianShare(r.callOutFee, rules) : 0 });
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
      return { jobs: await Promise.all(jobs.map((r) => this.jobView(r, tech))), earnings: await model.earnings(tech.id), rating: await model.ratingFor(tech.id) };
    },
    async jobView(r, tech) {
      const base = { ...brief(r), status: r.status, youEarn: technicianShare(r.callOutFee, rules), assignedAt: r.assignedAt, onTheWayAt: r.onTheWayAt, arrivedAt: r.arrivedAt, inspectedAt: r.inspectedAt, payoutStatus: r.payoutStatus, payoutAmount: r.payoutAmount };
      if (r.technicianId !== tech.id) return base;
      return {
        ...base, address: `${r.addressLine}, ${place(r)}`, customer: { name: r.contactName, phone: r.contactPhone },
        faultPhotos: (await model.photos(r.id, 'fault')).map((p) => p.id), inspectionPhotos: (await model.photos(r.id, 'inspection')).map((p) => p.id), report: await reportView(r, { forTechnician: true }), work: await workView(r, { forTechnician: true }),
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

    // ---- the repair itself (technician) ----
    async startRepair(tech, ref) {
      const r = await ownedJob(tech, ref);
      if (r.status === 'in_repair') return { status: 'in_repair', already: true };
      if (!(await model.startRepair({ requestId: r.id, technicianId: tech.id, at: now() }))) throw bad(409, 'NOT_READY', 'You can start once the customer has approved and paid for the estimate.');
      return { status: 'in_repair' };
    },
    async awaitingParts(tech, ref, note) {
      const r = await ownedJob(tech, ref);
      if (!(await model.setAwaitingParts({ requestId: r.id, technicianId: tech.id, waiting: true, note }))) throw bad(409, 'NOT_READY', 'You can mark "waiting for parts" while the repair is under way.');
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('repair_awaiting_parts', { request: brief(r), customer: { email: customer?.email, fullName: customer?.full_name }, note });
      return { status: 'awaiting_parts' };
    },
    async partsArrived(tech, ref) {
      const r = await ownedJob(tech, ref);
      if (!(await model.setAwaitingParts({ requestId: r.id, technicianId: tech.id, waiting: false }))) throw bad(409, 'NOT_READY', 'This repair is not waiting for parts.');
      return { status: 'in_repair' };
    },
    // Extra parts or labour found during the repair. The customer must approve and pay before it counts.
    async proposeVariation(tech, ref, input) {
      const r = await ownedJob(tech, ref);
      const extra = input.parts.reduce((x, p) => x + p.qty * p.unitPrice, 0) + input.labour;
      if (extra <= 0) throw bad(400, 'VALIDATION_ERROR', 'Add at least one part or some labour so there is an extra cost.');
      if ((r.agreedTotal ?? 0) + extra > 5_000_000) throw bad(400, 'VALIDATION_ERROR', 'That total is more than we can quote here. Contact TerraVoltix support.');
      const res = await model.proposeVariation({ requestId: r.id, technicianId: tech.id, reason: input.reason, parts: input.parts, labour: input.labour, extraTotal: extra });
      if (res.error === 'PENDING') throw bad(409, 'PENDING', 'A revised estimate is already waiting for the customer. Withdraw it first to send another.');
      if (res.error) throw bad(409, 'NOT_READY', 'You can propose a change while the repair is under way.');
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('repair_variation', { request: brief(r), customer: { email: customer?.email, fullName: customer?.full_name }, extra, reason: input.reason });
      return { id: res.id, extraTotal: extra };
    },
    async withdrawVariation(tech, ref, id) {
      const r = await ownedJob(tech, ref);
      if (!(await model.closeVariation({ id, requestId: r.id, to: 'withdrawn', at: now(), actor: 'technician' }))) throw bad(409, 'NOT_READY', 'There is no pending revised estimate to withdraw.');
      return { withdrawn: true };
    },
    async addCompletionPhoto(tech, ref, body) {
      const r = await ownedJob(tech, ref);
      if (!['in_repair', 'awaiting_parts'].includes(r.status)) throw bad(409, 'PHOTOS_CLOSED', 'Add pictures of the finished work before you report the repair as done.');
      if ((await model.photos(r.id, 'completion')).length >= MAX_COMPLETION_PHOTOS) throw bad(409, 'TOO_MANY_PHOTOS', `You can add up to ${MAX_COMPLETION_PHOTOS} pictures.`);
      return { id: await storePhoto(r.id, tech.id, 'completion', body) };
    },
    async removeCompletionPhoto(tech, ref, id) {
      const r = await ownedJob(tech, ref);
      if (!['in_repair', 'awaiting_parts'].includes(r.status)) throw bad(409, 'PHOTOS_CLOSED', 'Pictures can no longer be changed.');
      if (!(await model.removePhoto(r.id, id, tech.id))) throw notFound();
      return { removed: true };
    },
    // Work finished: at least one picture and a short summary. The customer then has a set time to confirm.
    async complete(tech, ref, summary) {
      const r = await ownedJob(tech, ref);
      if (r.status === 'repair_done') throw bad(409, 'ALREADY_REPORTED', 'You already reported this repair as finished.');
      if (r.status !== 'in_repair') throw bad(409, 'NOT_READY', 'The repair must be under way (not waiting for parts) before you can finish it.');
      if ((await model.variations(r.id)).some((v) => v.status === 'proposed')) throw bad(409, 'PENDING', 'A revised estimate is still waiting for the customer. Withdraw it or wait for the answer first.');
      if ((await model.photos(r.id, 'completion')).length === 0) throw bad(400, 'PHOTO_REQUIRED', 'Add at least one picture of the finished work.');
      const res = await model.complete({ requestId: r.id, technicianId: tech.id, summary, at: now(), confirmDueAt: new Date(now().getTime() + rules.confirmHours * 60 * MINUTE) });
      if (res.error === 'PENDING') throw bad(409, 'PENDING', 'A revised estimate is still waiting for the customer. Withdraw it or wait for the answer first.');
      if (res.error) throw bad(409, 'NOT_READY', 'The repair must be under way (not waiting for parts) before you can finish it.');
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('repair_done', { request: brief(r), customer: { email: customer?.email, fullName: customer?.full_name }, hours: rules.confirmHours });
      return { status: 'repair_done' };
    },

    // ---------- admin ----------
    async adminList({ status, needsAction }) { return { requests: await model.listForAdmin({ status, needsAction }), stats: await model.adminStats() }; },
    async adminGet(ref) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      const [customer, technician, matches, events, faultPhotos, report] = await Promise.all([person(r.customerId), person(r.technicianId), model.matches(r.id), model.events(r.id), model.photos(r.id), reportView(r)]);
      const work = await workView(r, { forTechnician: true });
      // Technicians the admin could pick by hand: every available technician, ranked, including those at capacity.
      const choices = r.status === 'finding' ? (await ranking(r)).map((c) => ({ id: c.id, name: c.fullName, score: c.score, distanceKm: c.distanceKm, atCapacity: c.atCapacity, activeJobs: c.activeJobs, completedJobs: c.completedJobs })) : [];
      return {
        request: { ...r, fault: label(FAULT_TYPES, r.faultType), equipment: r.equipment.map((e) => label(EQUIPMENT, e)), place: place(r), customer, technician },
        matches, timeline: events, photos: faultPhotos.map((p) => ({ id: p.id, kind: p.kind })), report, work, choices, adminMinutes: rules.adminMinutes,
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
      const from = ['finding', 'assigned', 'on_the_way', 'on_site', 'inspected', 'approved', 'in_repair', 'awaiting_parts', 'repair_done'];
      if (!from.includes(r.status)) throw bad(409, 'NOT_CANCELLABLE', 'This request cannot be cancelled now.');
      // Everything the customer paid goes back; no payout is owed.
      const ok = await model.cancel({ requestId: r.id, reason, at: now(), refundAmount: r.paidAmount, from: [r.status], actor: 'admin' });
      if (!ok) throw bad(409, 'NOT_CANCELLABLE', 'This request cannot be cancelled now.');
      await audit({ adminId, action: 'repair.cancel', target: `repair:${r.ref}`, detail: { reason, refund: r.paidAmount } });
      const customer = await usersModel.findById(r.customerId);
      await notifier.notify('repair_cancelled', { request: brief(r), refund: r.paidAmount, reason, customer: { email: customer?.email, fullName: customer?.full_name }, technician: await person(r.technicianId) });
      return { status: 'cancelled' };
    },
    // The admin closes a finished repair for the customer (after a reported problem was sorted out).
    async adminConfirm(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (!(await model.confirm({ requestId: r.id, at: now(), actor: 'admin', payoutAmount: technicianShare(r.agreedTotal ?? 0, rules) }))) throw bad(409, 'NOT_READY', 'This repair is not waiting to be closed.');
      await audit({ adminId, action: 'repair.confirm', target: `repair:${r.ref}`, detail: { payout: technicianShare(r.agreedTotal ?? 0, rules) } });
      await notifier.notify('repair_completed', { request: brief(r), technician: await person(r.technicianId), earn: technicianShare(r.agreedTotal ?? 0, rules), auto: false });
      return { status: 'completed' };
    },
    async adminPayoutPaid(adminId, ref, audit) {
      const r = await model.findByRef(String(ref));
      if (!r) throw notFound();
      if (!(await model.markPayoutPaid(r.id, now()))) throw bad(409, 'NOTHING_OWED', 'There is no payout owed on this repair.');
      await model.addEvent(r.id, 'payout_paid', 'admin');
      await audit({ adminId, action: 'repair.payout', target: `repair:${r.ref}`, detail: { amount: r.payoutAmount } });
      return { payoutStatus: 'paid' };
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
      let autoConfirmed = 0;
      for (const r of await model.dueConfirm(t)) {
        const earn = technicianShare(r.agreedTotal ?? 0, rules);
        if (!(await model.confirm({ requestId: r.id, at: t, actor: 'system', payoutAmount: earn }))) continue;
        await notifier.notify('repair_completed', { request: brief(r), technician: await person(r.technicianId), earn, auto: true });
        autoConfirmed += 1;
      }
      return { autoApproved, lapsed, autoConfirmed };
    },
  };

  async function ownedJob(tech, ref) {
    const r = await model.findByRef(String(ref));
    if (!r || r.technicianId !== tech.id) throw notFound();
    return r;
  }
}
