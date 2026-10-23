import { z } from 'zod';
import { CATEGORY_SPECS, PRODUCT_CATEGORIES, isCore } from '../utils/productCategories.js';
import { EAAS_RULES, validateEaasTerms } from '../utils/eaas.js';
import { LEASE_RULES, validateLeaseTerms } from '../utils/lease.js';

const naira = z.number({ invalid_type_error: 'Enter an amount in naira.' }).int('Use a whole number of naira.').min(50, 'That looks too low.').max(2_000_000_000, 'That looks too high.');
const optionalText = (max) =>
  z.string().trim().max(max, `Keep this under ${max} characters.`).optional().nullable().transform((v) => (v ? v : null));
const years = z.number().int().min(0).max(25).optional().nullable().transform((v) => v ?? null);

export const productSchema = z
  .object({
    category: z.enum(PRODUCT_CATEGORIES, { errorMap: () => ({ message: 'Choose a type.' }) }),
    name: z.string().trim().min(2, 'Give it a name.').max(120),
    brand: optionalText(60),
    rating: z.number({ invalid_type_error: 'Enter a number.' }).optional().nullable(),
    systemVoltage: z.number().int().optional().nullable(),
    batteryType: z.enum(['lithium', 'gel', 'tubular', 'agm']).optional().nullable(),
    price: naira,
    inStock: z.boolean().default(true),
    warrantyYears: years,
    description: optionalText(500),
    status: z.enum(['active', 'hidden']).default('active'),
    imageId: z.number().int().positive().nullable().optional(),
  })
  .superRefine((p, ctx) => {
    const bad = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
    const spec = CATEGORY_SPECS[p.category];
    if (!spec) return;
    // Panels, inverters and batteries drive the energy sizing, so their prices must look real.
    if (isCore(p.category) && p.price < 1000) bad('price', 'That looks too low.');

    // The main size (watts, kVA, kWh, amps ...), when this kind of product has one.
    const r = spec.rating;
    const given = p.rating !== undefined && p.rating !== null;
    if (r.mode === 'required' && !given) bad('rating', 'Enter a number.');
    if (r.mode !== 'none' && given) {
      if (p.rating <= 0) bad('rating', 'Enter a number above zero.');
      else if (r.integer && !Number.isInteger(p.rating)) bad('rating', `Use a whole number (${r.unit}).`);
      else if (p.rating < r.min || p.rating > r.max) bad('rating', `${r.label.replace(/ \(.*\)$/, '')} should be between ${r.min} and ${r.max} ${r.unit}.`);
    }

    // The battery voltage it works with.
    if (spec.voltage === 'required' && ![12, 24, 48].includes(p.systemVoltage)) bad('systemVoltage', 'Choose 12V, 24V or 48V.');
    if (spec.voltage === 'optional' && p.systemVoltage != null && ![12, 24, 48].includes(p.systemVoltage)) bad('systemVoltage', 'Choose 12V, 24V or 48V.');
  })
  .transform((p) => {
    const spec = CATEGORY_SPECS[p.category];
    return {
      ...p,
      // Products with no size are stored with 0 so the database column (which is never empty) stays valid.
      rating: spec.rating.mode === 'none' || p.rating == null ? 0 : Math.round(p.rating * 100) / 100,
      systemVoltage: spec.voltage === 'none' ? null : p.systemVoltage ?? null,
      batteryType: p.category === 'battery' ? p.batteryType ?? null : null,
    };
  });

const itemSchema = z.object({
  productId: z.number().int().positive(),
  qty: z.number().int().min(1, 'At least 1.').max(500, 'That is a lot. Check the quantity.'),
});

const leaseSchema = z
  .object({
    depositPct: z.number({ invalid_type_error: 'Enter a percentage.' }),
    tenors: z.array(z.number().int()).max(4),
  })
  .superRefine((l, ctx) => {
    const errors = validateLeaseTerms({ depositPct: l.depositPct / 100, tenors: l.tenors }, LEASE_RULES);
    if (errors.depositPct) ctx.addIssue({ code: 'custom', path: ['depositPct'], message: errors.depositPct });
    if (errors.tenors) ctx.addIssue({ code: 'custom', path: ['tenors'], message: errors.tenors });
  });
export const eaasSchema = z
  .object({
    tenorMonths: z.number({ invalid_type_error: 'Enter a number of months.' }).int('Use whole months.'),
    annualReturnPct: z.number({ invalid_type_error: 'Enter a percentage.' }),
    equipmentCost: naira.nullable().optional(),
    installationCost: z.number().int().min(0).max(2_000_000_000).optional().default(0),
    installationMode: z.enum(['upfront', 'rolled']).default('upfront'),
    overagePerKwh: z.number().min(0).max(100_000).nullable().optional(),
  })
  .superRefine((e, ctx) => {
    const errors = validateEaasTerms({ tenorMonths: e.tenorMonths, annualReturn: e.annualReturnPct / 100 }, EAAS_RULES);
    if (errors.tenorMonths) ctx.addIssue({ code: 'custom', path: ['tenorMonths'], message: errors.tenorMonths });
    if (errors.annualReturn) ctx.addIssue({ code: 'custom', path: ['annualReturnPct'], message: errors.annualReturn });
  });

export const dealSchema = z
  .object({
    title: z.string().trim().min(3, 'Give the deal a name.').max(120),
    description: optionalText(600),
    items: z.array(itemSchema).min(3, 'A deal needs panels, an inverter and a battery.').max(10),
    installationIncluded: z.boolean().default(true),
    warrantyYears: years,
    buyPrice: naira.nullable().optional(),
    lease: leaseSchema.nullable().optional(),
    imageId: z.number().int().positive().nullable().optional(),
    rentMonthly: naira.nullable().optional(),
    eaas: eaasSchema.nullable().optional(),
    status: z.enum(['draft', 'active', 'paused']).default('draft'),
  })
  .superRefine((d, ctx) => {
    const ids = d.items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Each product can only appear once.' });
    if (d.lease && d.buyPrice == null) {
      ctx.addIssue({ code: 'custom', path: ['lease', 'depositPct'], message: 'Lease is priced from the buy price. Set a buy price first.' });
    }
    if (d.buyPrice == null && !d.lease && d.rentMonthly == null && !d.eaas) {
      ctx.addIssue({ code: 'custom', path: ['plans'], message: 'Set a price for at least one way to pay: buy, lease, rent or energy as a service.' });
    }
  })
  .transform((d) => ({
    title: d.title,
    description: d.description,
    items: d.items,
    installationIncluded: d.installationIncluded,
    warrantyYears: d.warrantyYears,
    buyPrice: d.buyPrice ?? null,
    // Lease is priced from the buy price and the plan lengths; the old typed-in lease fields are no longer used.
    leaseDeposit: null,
    leaseMonthly: null,
    leaseMonths: null,
    leaseTerms: d.lease ? { depositPct: Math.round(d.lease.depositPct * 100) / 10000, tenors: [...new Set(d.lease.tenors)].sort((a, b) => a - b) } : null,
    imageId: d.imageId ?? null,
    rentMonthly: d.rentMonthly ?? null,
    // Energy as a service is priced from these terms; the old typed-in monthly fee is no longer used.
    eaasMonthly: null,
    eaasMonths: null,
    eaasTerms: d.eaas
      ? {
          tenorMonths: d.eaas.tenorMonths,
          annualReturn: Math.round(d.eaas.annualReturnPct * 100) / 10000,
          equipmentCost: d.eaas.equipmentCost ?? null,
          installationCost: d.eaas.installationCost,
          installationMode: d.eaas.installationMode,
          overagePerKwh: d.eaas.overagePerKwh ?? null,
        }
      : null,
    status: d.status,
  }));

export const dealStatusSchema = z.object({ status: z.enum(['draft', 'active', 'paused']) });
export const requestStatusSchema = z.object({ status: z.enum(['contacted', 'won', 'lost']) });

export const diyQuoteSchema = z.object({ items: z.array(itemSchema).min(1).max(10) });

export const createRequestSchema = z
  .object({
    kind: z.enum(['deal', 'diy']),
    dealId: z.number().int().positive().optional(),
    plan: z.enum(['buy', 'lease', 'rent', 'eaas']).optional(),
    months: z.number().int().min(1).max(120).optional(),
    items: z.array(itemSchema).max(10).optional(),
    message: optionalText(500),
  })
  .superRefine((r, ctx) => {
    if (r.kind === 'deal' && (!r.dealId || !r.plan)) ctx.addIssue({ code: 'custom', path: ['dealId'], message: 'Choose a deal and a way to pay.' });
    if (r.kind === 'diy' && (!r.items || r.items.length === 0)) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Pick your parts first.' });
  });

export const eaasPreviewSchema = z.object({
  items: z.array(itemSchema).min(3).max(10),
  eaas: eaasSchema,
});

export const leasePreviewSchema = z.object({ buyPrice: naira, lease: leaseSchema });
