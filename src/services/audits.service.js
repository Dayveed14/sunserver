import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { HttpError } from '../lib/httpError.js';
import { findArea, stateName } from '../utils/areas.js';
import { CLIENT_ROLES, EDITABLE, GPS_MAX_ACCURACY_M, PHOTO_SLOTS, PRIVATE_SLOTS, SITE_TYPES, SLOT_KEYS, SOURCE_KINDS, assessmentInput, computeAudit, missingForSubmit, straightKm, upgradeForm } from '../utils/auditRules.js';
import { buildPublicCatalog } from '../utils/catalog/index.js';

export const AUDIT_REF_PREFIX = 'AU-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const bad = (status, c, message, details) => new HttpError(status, c, message, details);
const notFound = () => bad(404, 'NOT_FOUND', 'Not found.');
const naira = (n) => `₦${Number(n).toLocaleString('en-NG')}`;
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const HOUR = 3600 * 1000;

// Site audits for businesses. A business asks, the admin assigns a field agent, the agent surveys the site on a phone,
// and the result is worked out by the same business calculator the free assessment uses. The admin reviews what the agent
// submitted (sending it to a technical check if the agent flagged it) and approves it; only then does the business see the
// result. It is saved as an ordinary assessment for the business, so choosing buy / lease / rent / energy as a service and asking vendors for
// quotes works exactly as it does everywhere else. Vendors see nothing until the customer picks an option.
export function createAuditsService({ model, assessmentsModel, imageService, resetsModel, usersModel, mailer, catalogs, assumptions, config, now = () => new Date() }) {
  const place = (a) => `${a.addressLine}, ${findArea(a.state, a.areaId)?.name ?? a.areaId}, ${stateName(a.state) ?? a.state}`;
  const link = (path) => `${config.appUrl.replace(/\/$/, '')}${path}`;

  // An email that fails must never block the work, so every send is caught and logged.
  async function send(to, message) {
    if (!to || (Array.isArray(to) && to.length === 0)) return;
    try { await mailer.sendNotification({ to, ...message }); } catch (err) { console.error(`[audit] could not email ${to}: ${err.message}`); }
  }

  const summaryLines = (result) => [
    `Energy use: about ${result.usage.kwhPerDay} kWh a day (${result.usage.kwhPerMonth} kWh a month).`,
    `Recommended solar system: ${result.solar.kwp} kWp of panels, ${result.solar.batteryKwh} kWh of battery and a ${result.solar.inverterKva} kVA inverter, about ${naira(result.solar.systemCost)}.`,
    result.audit.eaasEligible ? 'Energy as a service is available for this site, along with buying, leasing and renting.' : 'You can buy, lease or rent this system.',
  ];

  // ---------- views ----------
  const photoUrl = (imageId) => `/api/audit-photos/${imageId}`;
  const photoMap = (photos) => Object.fromEntries(photos.map((p) => [p.slot, { imageId: p.imageId, url: photoUrl(p.imageId) }]));

  const siteBlock = (a) => ({ line: a.addressLine, state: a.state, areaId: a.areaId, place: place(a) });

  // The business sees its own request, the agent's name once one is assigned, the timeline, and the result once it is in.
  function businessView(a, { agent = null, timeline = null, photos = null } = {}) {
    const showAgent = agent && ['assigned', 'in_progress', 'submitted', 'technical_review', 'completed', 'reopened'].includes(a.status);
    return {
      ref: a.ref, status: a.status === 'technical_review' ? 'submitted' : a.status, contactName: a.contactName, contactPhone: a.contactPhone, address: siteBlock(a),
      preferredDate: a.preferredDate, notes: a.notes, createdAt: a.createdAt, assignedAt: a.assignedAt, startedAt: a.startedAt, completedAt: a.completedAt,
      version: a.approvedVersion || (a.result ? a.version : 0), underReview: ['reopened', 'submitted', 'technical_review'].includes(a.status) && a.result != null,
      agent: showAgent ? { name: agent.fullName, phone: agent.phone } : null,
      // While an audit is being rechecked the earlier numbers stay visible, clearly marked, so nothing disappears.
      result: a.result, assessmentId: a.assessmentId, eaasEligible: a.eaasEligible,
      photos: photos ? Object.fromEntries(Object.entries(photoMap(photos)).filter(([k]) => !PRIVATE_SLOTS.includes(k))) : null,
      // The technical check is TerraVoltix's business, not the customer's.
      timeline: timeline?.filter((e) => e.type !== 'technical_review').map((e) => ({ type: e.type, at: e.at })) ?? null,
    };
  }

  // The agent sees the job, the contact, their draft and which photos are done.
  function agentView(a, { business = null, photos = [], timeline = null } = {}) {
    const form = upgradeForm(a.form);
    const have = new Set(photos.map((p) => p.slot));
    return {
      ref: a.ref, status: a.status, editable: EDITABLE.includes(a.status), address: siteBlock(a), preferredDate: a.preferredDate, notes: a.notes,
      contact: { name: a.contactName, phone: a.contactPhone }, businessName: a.businessName ?? business?.fullName ?? null,
      assignedAt: a.assignedAt, startedAt: a.startedAt, completedAt: a.completedAt, version: a.version, reviewNote: a.status === 'reopened' ? a.reviewNote : null,
      form, upgraded: Boolean(a.form) && a.form.v !== 2, photos: photoMap(photos), missing: missingForSubmit(form, [...have]),
      result: a.result, timeline: timeline?.map((e) => ({ type: e.type, actor: e.actor, at: e.at })) ?? null,
    };
  }

  const adminView = (a, extra = {}) => ({ ...businessView(a), status: a.status, contact: { name: a.contactName, phone: a.contactPhone }, businessName: a.businessName, companyName: a.companyName, businessEmail: a.businessEmail, agentId: a.agentId, agentName: a.agentName ?? null, reviewNote: a.reviewNote, kwhPerDay: a.kwhPerDay, needsTechnical: a.needsTechnical, technicalNote: a.technicalNote, submittedAt: a.submittedAt, ...extra });

  async function ownedByBusiness(user, ref) {
    const a = await model.findByRef(String(ref));
    if (!a || a.businessId !== user.id) throw notFound();
    return a;
  }
  async function ownedByAgent(user, ref) {
    const a = await model.findByRef(String(ref));
    if (!a || a.agentId !== user.id) throw notFound();
    return a;
  }
  const mustEdit = (a) => {
    if (!EDITABLE.includes(a.status)) throw bad(409, 'NOT_EDITABLE', a.status === 'completed' ? 'This audit is finished. The admin can reopen it if something needs changing.' : 'Start the visit first.');
  };

  return {
    // ---------- business ----------
    async request(user, input) {
      let ref;
      for (let i = 0; i < 5; i++) {
        ref = `${AUDIT_REF_PREFIX}${code(6)}`;
        if (!(await model.findByRef(ref))) break;
      }
      const id = await model.create({
        ref, businessId: user.id, contactName: input.contactName ?? user.fullName, contactPhone: input.contactPhone ?? user.phone ?? '',
        state: input.state, areaId: input.areaId, addressLine: input.line, preferredDate: input.preferredDate ?? null, notes: input.notes ?? null,
      });
      const a = await model.findByRef(ref);
      await send(user.email, {
        subject: `We received your energy assessment request · ${ref}`, heading: 'Your request has been started',
        lines: [`Reference ${ref}.`, `A field agent will be sent to ${place(a)}.`, 'We will email you as soon as an agent is assigned, when the visit starts, and when your results are ready.'],
        button: { label: 'Follow your request', url: link(`/app/site-assessment/${ref}`) },
      });
      await send(config.adminEmail, {
        subject: `New energy assessment request · ${ref}`, heading: 'A business needs a field assessment',
        lines: [`${user.companyName ?? user.fullName} (${user.email}) asked for a site assessment.`, `Site: ${place(a)}.`, `Contact: ${a.contactName}, ${a.contactPhone}.`, a.preferredDate ? `Preferred date: ${a.preferredDate}.` : 'No preferred date given.'],
        button: { label: 'Assign an agent', url: link('/app/audits') },
      });
      return businessView(a, { timeline: await model.events(id) });
    },
    async listMine(user) {
      return { audits: (await model.listForBusiness(user.id)).map((a) => businessView(a)) };
    },
    async getMine(user, ref) {
      const a = await ownedByBusiness(user, ref);
      const agent = a.agentId ? await model.findUser(a.agentId) : null;
      return businessView(a, { agent, timeline: await model.events(a.id), photos: await model.photos(a.id) });
    },

    // ---------- admin ----------
    // "needs_action" is the admin's to-do: new requests to assign, and submitted audits to review.
    async adminList({ status } = {}) {
      const statuses = status === 'needs_action' ? ['requested', 'submitted', 'technical_review'] : status;
      return { audits: (await model.listForAdmin({ status: statuses })).map((a) => ({ ...adminView(a), result: undefined })) };
    },
    async adminGet(ref) {
      const a = (await model.listForAdmin({ ref: String(ref) }))[0];
      if (!a) throw notFound();
      const photos = await model.photos(a.id);
      const waiting = ['submitted', 'technical_review'].includes(a.status) ? await model.pendingVersion(a.id) : null;
      const form = upgradeForm(waiting?.form ?? a.form);
      // Where the agent says the site is, against where the customer said it is: a big gap is worth a phone call.
      const centre = findArea(a.state, a.areaId);
      const gps = form.site.gps;
      const gpsOffKm = gps && centre ? Math.round(straightKm({ lat: gps.lat, lng: gps.lng }, centre) * 10) / 10 : null;
      return adminView(a, {
        timeline: (await model.events(a.id)).map((e) => ({ type: e.type, actor: e.actor, note: e.note, at: e.at })), photos: photoMap(photos), versions: await model.versions(a.id),
        form, formUpgraded: Boolean(waiting?.form ?? a.form) && (waiting?.form ?? a.form).v !== 2, missing: undefined,
        // What is waiting to be approved (the customer sees none of this until then).
        pending: waiting ? { version: waiting.version, result: waiting.result } : null,
        gpsCheck: gps ? { accuracyM: gps.accuracyM ?? null, capturedAt: gps.capturedAt ?? null, offKm: gpsOffKm, far: gpsOffKm != null && gpsOffKm > 15 } : null,
      });
    },
    async assign(adminId, ref, agentId) {
      const a = await model.findByRef(String(ref));
      if (!a) throw notFound();
      const agent = await model.findAgent(agentId);
      if (!agent || !agent.active) throw bad(400, 'INVALID_AGENT', 'Choose an active field agent.');
      const res = await model.assign(a.id, agent.id);
      if (!res.ok) throw bad(409, 'NOT_ASSIGNABLE', 'This audit can no longer be handed to an agent.');
      const business = await model.findUser(a.businessId);
      await send(business?.email, {
        subject: `A field agent has been assigned · ${a.ref}`, heading: 'Your field agent is assigned',
        lines: [`${agent.fullName} will visit ${place(a)}.`, agent.phone ? `You can reach them on ${agent.phone}.` : 'They will contact you before the visit.', 'You will be told when the visit starts.'],
        button: { label: 'Follow your request', url: link(`/app/site-assessment/${a.ref}`) },
      });
      await send(agent.email, {
        subject: `New site audit · ${a.ref}`, heading: 'You have a new site audit',
        lines: [`Site: ${place(a)}.`, `Contact: ${a.contactName}, ${a.contactPhone}.`, a.preferredDate ? `Preferred date: ${a.preferredDate}.` : 'No preferred date was given.'],
        button: { label: 'Open the job', url: link(`/app/jobs/${a.ref}`) },
      });
      return { ok: true, status: res.status, agent: { id: agent.id, name: agent.fullName } };
    },
    async reopen(adminId, ref, note) {
      const a = await model.findByRef(String(ref));
      if (!a) throw notFound();
      const res = await model.reopen(a.id, note);
      if (!res.ok) throw bad(409, 'NOT_REOPENABLE', 'Only a submitted or finished audit can be sent back.');
      const business = await model.findUser(a.businessId);
      const agent = a.agentId ? await model.findUser(a.agentId) : null;
      await send(agent?.email, { subject: `Audit sent back to you · ${a.ref}`, heading: 'Please recheck this audit', lines: [`Site: ${place(a)}.`, `Reason: ${note}`, 'Correct the form or photos and submit again.'], button: { label: 'Open the job', url: link(`/app/jobs/${a.ref}`) } });
      if (a.result) await send(business?.email, { subject: `Your assessment is being rechecked · ${a.ref}`, heading: 'We are rechecking your assessment', lines: ['Our team is double-checking some details from the visit. Your earlier numbers stay on your page, marked as under review, and you will get an email with the updated result.'], button: { label: 'Open your assessment', url: link(`/app/site-assessment/${a.ref}`) } });
      return { ok: true };
    },
    // The admin says an engineer should look before this goes to the customer. Nobody outside TerraVoltix is told.
    async technicalReview(adminId, ref, note) {
      const a = await model.findByRef(String(ref));
      if (!a) throw notFound();
      const res = await model.technicalReview(a.id, note);
      if (!res.ok) throw bad(409, 'NOT_REVIEWABLE', 'Only an audit waiting for review can go to a technical check.');
      return { ok: true, status: 'technical_review' };
    },
    // Approving releases the result: it becomes the customer's saved assessment and they are emailed.
    async approve(adminId, ref, note) {
      const a = await model.findByRef(String(ref));
      if (!a) throw notFound();
      if (!['submitted', 'technical_review'].includes(a.status)) throw bad(409, 'NOT_REVIEWABLE', 'This audit is not waiting for review.');
      if (a.needsTechnical && a.status !== 'technical_review') throw bad(409, 'TECHNICAL_REVIEW_FIRST', 'The agent flagged this audit. Send it to a technical check first.');
      if ((a.needsTechnical || a.status === 'technical_review') && !(note && note.trim().length >= 5)) throw bad(400, 'NOTE_REQUIRED', 'Write what the technical check found before approving.');
      const waiting = await model.pendingVersion(a.id);
      if (!waiting) throw bad(409, 'NOT_REVIEWABLE', 'There is nothing to approve.');
      const form = upgradeForm(waiting.form);
      const res = await model.approve(a.id, note?.trim() || null, async ({ version, result }) => {
        if (version !== waiting.version) throw bad(409, 'CHANGED', 'The audit changed while you were reviewing. Please look again.');
        const assessmentId = await assessmentsModel.create({
          userId: a.businessId, segment: 'business', disco: form.power.disco, supplyBand: form.power.supplyBand ?? null,
          input: { ...assessmentInput(form, result.audit.eaasEligible), auditRef: a.ref }, result,
        });
        return { assessmentId, kwhPerDay: result.usage.kwhPerDay, eaasEligible: result.audit.eaasEligible };
      });
      if (!res.ok) throw bad(409, 'NOT_REVIEWABLE', res.needsTechnical ? 'The agent flagged this audit. Send it to a technical check first.' : 'This audit was just handled.');
      const business = await model.findUser(a.businessId);
      const agent = a.agentId ? await model.findUser(a.agentId) : null;
      const lines = summaryLines(res.result);
      await send(business?.email, { subject: `Your energy assessment results · ${a.ref}`, heading: res.version > 1 ? 'Your updated energy assessment' : 'Your energy assessment is ready', lines: [`Site: ${place(a)}.`, ...lines, 'Choose how you would like to get it and we will connect you with vendors.'], button: { label: 'See your results and options', url: link(`/app/site-assessment/${a.ref}`) } });
      await send(agent?.email, { subject: `Audit approved · ${a.ref}`, heading: 'Your audit was approved', lines: [`${place(a)}. The result has gone to the business.`], button: { label: 'Open the job', url: link(`/app/jobs/${a.ref}`) } });
      return { ok: true, version: res.version };
    },
    async agents() {
      const [agents, open] = await Promise.all([model.listAgents(), model.countOpenForAgents()]);
      return { agents: agents.map((g) => ({ ...g, openJobs: open.get(g.id) ?? 0 })) };
    },
    async createAgent(adminId, { fullName, email, phone }) {
      if ((await usersModel.listByEmail(email)).length > 0) throw bad(409, 'EMAIL_TAKEN', 'This email already has a TerraVoltix account. Use a different email for the agent.');
      const hash = await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), config.bcryptRounds);
      const id = await usersModel.create({ email, passwordHash: hash, role: 'field_agent', fullName, phone: phone ?? null, verifiedAt: now() });
      // The agent sets their own password from a link, valid for three days.
      const token = crypto.randomBytes(32).toString('base64url');
      await resetsModel.create({ userId: id, tokenHash: sha256(token), expiresAt: new Date(now().getTime() + 72 * HOUR), createdAt: now() });
      await send(email, {
        subject: 'Your TerraVoltix field agent account', heading: `Welcome, ${fullName.split(' ')[0]}`,
        lines: ['You have been added as a TerraVoltix field agent. Choose a password to sign in. The link works for three days.', 'When you are assigned a site, you will get an email and the job will appear in your account.'],
        button: { label: 'Choose your password', url: config.resetLink(token) },
      });
      return { agent: { id, fullName, email, phone: phone ?? null, active: true, openJobs: 0 } };
    },

    // ---------- field agent ----------
    catalog() {
      const c = buildPublicCatalog('business');
      return {
        ...c,
        discos: assumptions.discos.map(({ id, name }) => ({ id, name })),
        photoSlots: PHOTO_SLOTS,
        siteTypes: SITE_TYPES.map(([id, label]) => ({ id, label })),
        clientRoles: CLIENT_ROLES.map(([id, label]) => ({ id, label })),
        sourceKinds: SOURCE_KINDS.map(([id, label]) => ({ id, label })),
        gpsMaxAccuracyM: GPS_MAX_ACCURACY_M,
        eaasMinKwhPerDay: assumptions.audit.eaasMinKwhPerDay,
      };
    },
    async jobs(user) {
      const list = await model.listForAgent(user.id);
      return { jobs: list.map((a) => ({ ref: a.ref, status: a.status, businessName: a.businessName, address: siteBlock(a), preferredDate: a.preferredDate, assignedAt: a.assignedAt, version: a.version, reviewNote: a.status === 'reopened' ? a.reviewNote : null })) };
    },
    async job(user, ref) {
      const a = await ownedByAgent(user, ref);
      return agentView(a, { photos: await model.photos(a.id), timeline: await model.events(a.id) });
    },
    async start(user, ref) {
      const a = await ownedByAgent(user, ref);
      const res = await model.start(a.id, user.id);
      if (!res.ok) throw bad(409, 'NOT_STARTABLE', 'This job cannot be started.');
      if (res.changed) {
        const business = await model.findUser(a.businessId);
        await send(business?.email, { subject: `Your site audit has started · ${a.ref}`, heading: 'The field audit is in progress', lines: [`${user.fullName} is at ${place(a)} now.`, 'Your results will be sent as soon as the visit is finished.'], button: { label: 'Follow your request', url: link(`/app/site-assessment/${a.ref}`) } });
      }
      return this.job(user, ref);
    },
    async saveDraft(user, ref, form) {
      const a = await ownedByAgent(user, ref);
      mustEdit(a);
      await model.saveDraft(a.id, user.id, form);
      const photos = await model.photos(a.id);
      return { saved: true, missing: missingForSubmit(form, photos.map((p) => p.slot)) };
    },
    async uploadPhoto(user, ref, slot, body) {
      if (!SLOT_KEYS.includes(slot)) throw bad(400, 'UNKNOWN_SLOT', 'Unknown photo type.');
      const a = await ownedByAgent(user, ref);
      mustEdit(a);
      const { id } = await imageService.store(user.id, body, { isPrivate: true });
      await model.setPhoto(a.id, slot, id);
      return { slot, imageId: id, url: photoUrl(id) };
    },
    // The same maths as the final result, shown to the agent as they go. Nothing is saved.
    async preview(user, ref, form) {
      const a = await ownedByAgent(user, ref);
      mustEdit(a);
      if (!form.power?.disco || form.appliances.length === 0) return { result: null };
      const { _assessmentInput, ...result } = computeAudit(form, { catalogs, assumptions });
      return { result };
    },
    async submit(user, ref, form) {
      const a = await ownedByAgent(user, ref);
      mustEdit(a);
      const photos = await model.photos(a.id);
      const missing = missingForSubmit(form, photos.map((p) => p.slot));
      if (Object.keys(missing).length) throw bad(400, 'INCOMPLETE', 'A few things are still missing.', { fields: missing });
      const { _assessmentInput, ...result } = computeAudit(form, { catalogs, assumptions });
      const needsTechnical = form.review?.needsTechnical === true;
      const res = await model.submit(a.id, user.id, { form, result, needsTechnical });
      if (!res.ok) throw bad(409, 'NOT_EDITABLE', 'This audit cannot be submitted right now.');
      const business = await model.findUser(a.businessId);
      const lines = summaryLines(result);
      await send(user.email, { subject: `Audit submitted · ${a.ref}`, heading: 'Audit submitted for review', lines: [`${place(a)}.`, 'The admin checks it before the business sees the result.', ...lines], button: { label: 'Open the job', url: link(`/app/jobs/${a.ref}`) } });
      await send(business?.email, { subject: `The site visit is finished · ${a.ref}`, heading: 'The visit is done', lines: [`${user.fullName} has finished the survey at ${place(a)}.`, 'Our team is checking the figures. You will get an email as soon as your results are ready.'], button: { label: 'Follow your request', url: link(`/app/site-assessment/${a.ref}`) } });
      await send(config.adminEmail, { subject: `${needsTechnical ? 'TECHNICAL REVIEW FLAGGED · ' : 'Audit to review · '}${a.ref}`, heading: res.version > 1 ? 'An audit was resubmitted' : 'An audit is waiting for your review', lines: [`${business?.fullName ?? 'A business'} · ${place(a)}.`, `By ${user.fullName}.`, ...(needsTechnical ? [`The agent says it needs a technical review: ${form.review.reason}`] : []), ...lines], button: { label: 'Review it', url: link('/app/audits') } });
      return { version: res.version, status: 'submitted', result };
    },

    // ---------- private photos ----------
    // Only the business that owns the audit, its assigned agent and the admin may open a site picture.
    async viewPhoto(user, imageId) {
      const owner = await model.auditForImage(imageId);
      const allowed = owner && (user.role === 'admin' || (user.role === 'business' && owner.businessId === user.id) || (user.role === 'field_agent' && owner.agentId === user.id));
      if (!allowed) throw notFound();
      return imageService.view(imageId, { allowPrivate: true });
    },
  };
}
