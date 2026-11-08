import { z } from 'zod';
import { HttpError } from '../lib/httpError.js';
import { estimate } from './calculator.js';

// Field site audits. A TerraVoltix agent visits a business, fills in the survey on a phone and takes photos.
// The energy maths is the same business calculator customers already use, so an audited number and a self-serve
// number are produced the same way. This file adds what only a visit can: roof space, real fuel spend, sizes, and
// whether the site is big enough for energy as a service.

export const AUDIT_STATUSES = ['requested', 'assigned', 'in_progress', 'completed', 'reopened'];
export const EDITABLE = ['in_progress', 'reopened'];

// Photos the agent takes. `needsGenerator` slots are only asked for when the site runs a generator.
export const PHOTO_SLOTS = [
  { key: 'plaza', label: 'Full plaza or building', required: true },
  { key: 'roof', label: 'Roof', required: true },
  { key: 'exterior', label: 'Shop exterior', required: false },
  { key: 'interior', label: 'Shop interior', required: false },
  { key: 'equipment_space', label: 'Where the equipment would go', required: true },
  { key: 'generator', label: 'Generator and its size plate', required: true, needsGenerator: true },
  { key: 'signature', label: "Owner's signature", required: true },
];
export const SLOT_KEYS = PHOTO_SLOTS.map((s) => s.key);

const txt = (max) => z.string().trim().max(max).optional().nullable();
const num = (min, max) => z.number().finite().min(min).max(max).optional().nullable();

// What the agent may save at any time. Everything is optional so the form can be saved half-finished.
export const auditDraftSchema = z.object({
  site: z.object({
    plazaName: txt(120),
    section: z.enum(['plaza', 'kiosk']).optional().nullable(),
    shopNumber: txt(20),
    shopStatus: z.enum(['occupied', 'unoccupied']).optional().nullable(),
    gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: num(0, 100000) }).optional().nullable(),
  }).default({}),
  business: z.object({
    shopName: txt(120),
    ownerFirstName: txt(60),
    ownerLastName: txt(60),
    ownerPhone: txt(30),
    businessType: txt(80),
    yearsInPlaza: z.number().int().min(0).max(80).optional().nullable(),
  }).default({}),
  power: z.object({
    disco: txt(20),
    supplyBand: z.enum(['A', 'B', 'C', 'D', 'E']).optional().nullable(),
    usesGenerator: z.boolean().optional().nullable(),
    generatorType: z.enum(['petrol', 'diesel', 'gas', 'other']).optional().nullable(),
    generatorKva: num(0, 5000),
    fuelSpendPerWeek: num(0, 100000000),
    otherEnergy: txt(200),
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
  })).max(80).default([]),
  comments: txt(1500),
});

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// What is still missing before the agent may submit. Keys match the form so the screen can mark each field.
export function missingForSubmit(form, photoSlots) {
  const m = {};
  const need = (path, label, ok) => { if (!ok) m[path] = label; };
  need('site.plazaName', 'Plaza or market name', present(form.site?.plazaName));
  need('site.section', 'Plaza or kiosk', present(form.site?.section));
  need('site.shopStatus', 'Occupied or unoccupied', present(form.site?.shopStatus));
  need('site.gps', 'GPS location', Boolean(form.site?.gps));
  need('business.shopName', 'Shop or business name', present(form.business?.shopName));
  need('business.ownerFirstName', "Owner's first name", present(form.business?.ownerFirstName));
  need('business.ownerPhone', "Owner's phone", present(form.business?.ownerPhone));
  need('power.disco', 'Electricity company', present(form.power?.disco));
  need('power.usesGenerator', 'Does the shop use a generator?', form.power?.usesGenerator === true || form.power?.usesGenerator === false);
  need('appliances', 'At least one appliance', (form.appliances?.length ?? 0) > 0);
  const have = new Set(photoSlots);
  for (const slot of PHOTO_SLOTS) {
    if (slot.required && (!slot.needsGenerator || form.power?.usesGenerator === true)) need(`photo.${slot.key}`, `Photo: ${slot.label}`, have.has(slot.key));
  }
  return m;
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

  const weeklyFuel = form.power?.usesGenerator ? form.power?.fuelSpendPerWeek ?? null : null;
  const fuel = {
    reportedMonthly: weeklyFuel > 0 ? Math.round(weeklyFuel * R.weeksPerMonth) : null,
    modelledGeneratorMonthly: main.generator.monthlyCost,
  };

  return {
    ...main,
    audit: { eaasEligible, eaasMinKwhPerDay: R.eaasMinKwhPerDay, scenarios, roof, fuel },
    // What the saved assessment needs so the vendor-matching steps treat it like any other business result.
    _assessmentInput: { segment: 'business', disco, supplyBand, items, source: 'site-audit', ...(eaasEligible ? {} : { eaasAllowed: false }) },
  };
}

export const auditError = (status, code, message, details) => new HttpError(status, code, message, details);
