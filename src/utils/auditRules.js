import { z } from 'zod';
import { HttpError } from '../lib/httpError.js';
import { estimate } from './calculator.js';

// Field site audits. A TerraVoltix agent visits a business, fills in the survey on a phone and takes photos.
// The energy maths is the same business calculator customers already use, so an audited number and a self-serve
// number are produced the same way. This file adds what only a visit can: roof space, real fuel spend, sizes, and
// whether the site is big enough for energy as a service.

export const AUDIT_STATUSES = ['requested', 'assigned', 'in_progress', 'submitted', 'technical_review', 'completed', 'reopened'];
export const EDITABLE = ['in_progress', 'reopened'];
// The agent's form has had two shapes: version 1 was written for plazas and shops; version 2 fits any site. Old forms stay
// in the database exactly as they were saved and are upgraded when they are shown or edited (see upgradeForm).
export const FORM_VERSION = 2;
// A phone GPS fix worse than this is too rough to prove where the visit was.
export const GPS_MAX_ACCURACY_M = 100;

export const SITE_TYPES = [
  ['home', 'Home'], ['shop', 'Shop or kiosk'], ['plaza', 'Plaza or market'], ['office', 'Office'], ['restaurant', 'Restaurant, bar or hotel'],
  ['school', 'School'], ['clinic', 'Clinic or pharmacy'], ['worship', 'Church or mosque'], ['factory', 'Factory or workshop'], ['farm', 'Farm'], ['other', 'Other'],
];
export const CLIENT_ROLES = [['owner', 'Owner'], ['tenant', 'Tenant'], ['manager', 'Manager'], ['other', 'Other']];
export const SOURCE_KINDS = [['generator', 'Generator'], ['inverter', 'Inverter and battery'], ['solar', 'Solar already installed'], ['other', 'Something else']];

// Photos the agent takes. `needsGenerator` slots are only asked for when a generator is listed among the power sources.
// "plaza" is the old name of "building": audits done before version 2 keep their picture under it.
export const PHOTO_SLOTS = [
  { key: 'checkin', label: 'Check-in photo: you at the site', required: true },
  { key: 'building', label: 'The building or site', required: true },
  { key: 'roof', label: 'Roof', required: true },
  { key: 'meter', label: 'Electricity meter or distribution board', required: false },
  { key: 'exterior', label: 'Outside', required: false },
  { key: 'interior', label: 'Inside', required: false },
  { key: 'equipment_space', label: 'Where the equipment would go', required: true },
  { key: 'generator', label: 'Generator and its size plate', required: true, needsGenerator: true },
  { key: 'signature', label: "Client's signature", required: true },
  { key: 'agent_signature', label: "Agent's signature", required: true },
];
export const SLOT_KEYS = PHOTO_SLOTS.map((s) => s.key);
// Pictures only the agent and the admin see (the customer is not shown signatures or the check-in).
export const PRIVATE_SLOTS = ['signature', 'agent_signature', 'checkin'];

const txt = (max) => z.string().trim().max(max).optional().nullable();
const num = (min, max) => z.number().finite().min(min).max(max).optional().nullable();

// What the agent may save at any time. Everything is optional so the form can be saved half-finished.
export const auditDraftSchema = z.object({
  v: z.literal(FORM_VERSION).default(FORM_VERSION),
  site: z.object({
    siteName: txt(120),
    siteType: z.enum(SITE_TYPES.map(([k]) => k)).optional().nullable(),
    unit: txt(60),
    occupancy: z.enum(['occupied', 'vacant']).optional().nullable(),
    accessNotes: txt(300),
    gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: num(0, 100000), capturedAt: txt(40) }).optional().nullable(),
    // Only set when an old (plaza) audit was upgraded: the plaza-only answers, kept so nothing is lost.
    legacy: z.object({ section: txt(20), shopNumber: txt(20) }).optional().nullable(),
  }).default({}),
  client: z.object({
    organisation: txt(120),
    firstName: txt(60),
    lastName: txt(60),
    phone: txt(30),
    role: z.enum(CLIENT_ROLES.map(([k]) => k)).optional().nullable(),
    businessType: txt(80),
    yearsAtSite: z.number().int().min(0).max(80).optional().nullable(),
  }).default({}),
  power: z.object({
    disco: txt(20),
    supplyBand: z.enum(['A', 'B', 'C', 'D', 'E']).optional().nullable(),
    sources: z.array(z.object({
      kind: z.enum(SOURCE_KINDS.map(([k]) => k)),
      fuel: z.enum(['petrol', 'diesel', 'gas', 'other']).optional().nullable(),
      kva: num(0, 5000),
      fuelSpendPerWeek: num(0, 100000000),
      kwp: num(0, 100000),
      batteryKwh: num(0, 100000),
      note: txt(200),
    })).max(10).default([]),
    // The agent says there is nothing besides the grid, so an empty list is an answer and not a forgotten step.
    noOtherSources: z.boolean().optional().nullable(),
    landlordContact: txt(120),
    managerContact: txt(120),
  }).default({}),
  roof: z.object({
    areaM2: num(0, 100000),
    type: z.enum(['flat', 'pitched', 'other']).optional().nullable(),
  }).default({}),
  appliances: z.array(z.object({
    applianceId: z.string().trim().min(1).max(60),
    variantId: z.string().trim().min(1).max(60),
    qty: z.number().int().min(1).max(500),
    hoursKey: z.string().trim().max(20).optional().nullable(),
    critical: z.boolean().optional().nullable(),
    note: txt(120),
  })).max(80).default([]),
  // The agent's own call: something here needs an engineer's eye (structural doubt, three-phase supply, unusual loads).
  review: z.object({ needsTechnical: z.boolean().optional().nullable(), reason: txt(500) }).default({}),
  comments: txt(1500),
});

// Version-1 (plaza) forms become version-2 forms. Nothing is invented: a plaza answer that has no place in the new form goes
// under site.legacy. Called on every read, so old audits stay readable and a reopened one opens in the new form.
export function upgradeForm(raw) {
  if (raw && raw.v === FORM_VERSION) return auditDraftSchema.parse(raw);
  const old = raw ?? {};
  const s = old.site ?? {};
  const b = old.business ?? {};
  const p = old.power ?? {};
  const sources = [];
  if (p.usesGenerator === true) sources.push({ kind: 'generator', fuel: p.generatorType ?? null, kva: p.generatorKva ?? null, fuelSpendPerWeek: p.fuelSpendPerWeek ?? null });
  if (p.otherEnergy) sources.push({ kind: 'other', note: String(p.otherEnergy).slice(0, 200) });
  const hasOld = Boolean(raw && Object.keys(raw).length);
  return auditDraftSchema.parse({
    v: FORM_VERSION,
    site: {
      siteName: s.plazaName ?? null, siteType: hasOld && (s.plazaName || b.shopName) ? 'shop' : null, unit: s.shopNumber ?? null,
      occupancy: s.shopStatus === 'unoccupied' ? 'vacant' : s.shopStatus === 'occupied' ? 'occupied' : null, gps: s.gps ?? null,
      legacy: s.section || s.shopNumber ? { section: s.section ?? null, shopNumber: s.shopNumber ?? null } : null,
    },
    client: { organisation: b.shopName ?? null, firstName: b.ownerFirstName ?? null, lastName: b.ownerLastName ?? null, phone: b.ownerPhone ?? null, role: hasOld && b.ownerFirstName ? 'owner' : null, businessType: b.businessType ?? null, yearsAtSite: b.yearsInPlaza ?? null },
    power: { disco: p.disco ?? null, supplyBand: p.supplyBand ?? null, sources, noOtherSources: sources.length === 0 && p.usesGenerator === false ? true : null, landlordContact: p.landlordContact ?? null, managerContact: p.managerContact ?? null },
    roof: old.roof ?? {},
    appliances: old.appliances ?? [],
    review: {},
    comments: old.comments ?? null,
  });
}

export const hasGenerator = (form) => (form.power?.sources ?? []).some((x) => x.kind === 'generator');
// What the site already has, for the report (sizing does not subtract it: the audit measures what the site needs).
export function existingEquipment(form) {
  const src = form.power?.sources ?? [];
  const sum = (kind, field) => src.filter((x) => x.kind === kind).reduce((t, x) => t + (x[field] ?? 0), 0);
  return { generatorKva: sum('generator', 'kva'), inverterKva: sum('inverter', 'kva'), batteryKwh: sum('inverter', 'batteryKwh') + sum('solar', 'batteryKwh'), solarKwp: sum('solar', 'kwp') };
}

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// What is still missing before the agent may submit. Keys match the form so the screen can mark each field.
export function missingForSubmit(form, photoSlots) {
  const m = {};
  const need = (path, label, ok) => { if (!ok) m[path] = label; };
  need('site.siteName', 'Name of the site', present(form.site?.siteName));
  need('site.siteType', 'Type of site', present(form.site?.siteType));
  const gps = form.site?.gps;
  need('site.gps', !gps ? 'GPS location' : `GPS is too rough (${gps.accuracyM == null ? 'no accuracy' : `${gps.accuracyM} m`}): capture it again in the open, within ${GPS_MAX_ACCURACY_M} m`, Boolean(gps) && gps.accuracyM != null && gps.accuracyM <= GPS_MAX_ACCURACY_M);
  need('client.firstName', "Client's first name", present(form.client?.firstName));
  need('client.phone', "Client's phone", present(form.client?.phone));
  need('power.disco', 'Electricity company', present(form.power?.disco));
  need('power.sources', 'Power sources (or tick "nothing besides the grid")', (form.power?.sources?.length ?? 0) > 0 || form.power?.noOtherSources === true);
  need('appliances', 'At least one appliance', (form.appliances?.length ?? 0) > 0);
  need('review.reason', 'Say what needs a technical review', form.review?.needsTechnical !== true || present(form.review?.reason) && form.review.reason.trim().length >= 10);
  const have = new Set(photoSlots);
  if (have.has('plaza')) have.add('building');
  for (const slot of PHOTO_SLOTS) {
    if (slot.required && (!slot.needsGenerator || hasGenerator(form))) need(`photo.${slot.key}`, `Photo: ${slot.label}`, have.has(slot.key));
  }
  return m;
}

// Straight-line distance between two points on the earth, in km.
export function straightKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// What the saved assessment needs so the vendor-matching steps treat an audit like any other business result.
export function assessmentInput(form, eaasEligible) {
  const items = form.appliances.map((a) => ({ applianceId: a.applianceId, variantId: a.variantId, qty: a.qty, ...(a.hoursKey ? { hoursKey: a.hoursKey } : {}) }));
  return { segment: 'business', disco: form.power?.disco, supplyBand: form.power?.supplyBand ?? null, items, source: 'site-audit', ...(eaasEligible ? {} : { eaasAllowed: false }) };
}

// Works out the audited energy requirement. Throws HttpError for unknown appliances (from the calculator).
export function computeAudit(form, { catalogs, assumptions: A }) {
  const deps = { catalogs, assumptions: A };
  const disco = form.power?.disco;
  const supplyBand = form.power?.supplyBand ?? null;
  const toItem = (a) => ({ applianceId: a.applianceId, variantId: a.variantId, qty: a.qty, ...(a.hoursKey ? { hoursKey: a.hoursKey } : {}) });
  const items = form.appliances.map(toItem);
  const run = (its, extra = {}) => estimate({ segment: 'business', disco, supplyBand, items: its, ...extra }, deps);

  const first = run(items);
  const R = A.audit;
  const eaasEligible = first.usage.kwhPerDay >= R.eaasMinKwhPerDay;
  const main = eaasEligible ? first : run(items, { eaasAllowed: false });

  // Sizes: what is needed now, what keeps running in a power cut, and room to grow.
  const maxQty = new Map(catalogs.business.appliances.map((ap) => [ap.id, ap.maxQty]));
  const summarise = (key, label, r) => ({ key, label, kwhPerDay: r.usage.kwhPerDay, inverterKva: r.solar.inverterKva, kwp: r.solar.kwp, batteryKwh: r.solar.batteryKwh, systemCost: r.solar.systemCost });
  const scenarios = [];
  const critical = form.appliances.filter((a) => a.critical);
  if (critical.length > 0 && critical.length < form.appliances.length) scenarios.push(summarise('essentials', 'Essentials only (kept running in a power cut)', run(critical.map(toItem))));
  scenarios.push(summarise('full', 'Everything you use today', main));
  const grown = items.map((i) => ({ ...i, qty: Math.min(maxQty.get(i.applianceId) ?? i.qty, Math.ceil(i.qty * (1 + R.growthPct))) }));
  scenarios.push(summarise('growth', `With ${Math.round(R.growthPct * 100)}% room to grow`, run(grown)));

  const roofArea = form.roof?.areaM2 ?? null;
  const neededM2 = Math.round(main.solar.kwp * R.m2PerKwp);
  const roof = {
    areaM2: roofArea,
    neededM2,
    fits: roofArea == null || roofArea <= 0 ? null : roofArea >= neededM2,
    maxKwp: roofArea > 0 ? Math.round((roofArea / R.m2PerKwp) * 10) / 10 : null,
  };

  const weeklyFuel = hasGenerator(form) ? (form.power.sources.filter((x) => x.kind === 'generator').reduce((t, x) => t + (x.fuelSpendPerWeek ?? 0), 0) || null) : null;
  const fuel = {
    reportedMonthly: weeklyFuel > 0 ? Math.round(weeklyFuel * R.weeksPerMonth) : null,
    modelledGeneratorMonthly: main.generator.monthlyCost,
  };

  return {
    ...main,
    audit: { eaasEligible, eaasMinKwhPerDay: R.eaasMinKwhPerDay, scenarios, roof, fuel, existing: existingEquipment(form) },
    // What the saved assessment needs so the vendor-matching steps treat it like any other business result.
    _assessmentInput: assessmentInput(form, eaasEligible),
  };
}

export const auditError = (status, code, message, details) => new HttpError(status, code, message, details);
