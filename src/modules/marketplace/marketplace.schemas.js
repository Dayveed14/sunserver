import { z } from 'zod';
import { EAAS_RULES, validateEaasTerms } from './eaas.js';

const naira = z.number({ invalid_type_error: 'Enter an amount in naira.' }).int('Use a whole number of naira.').min(1000, 'That looks too low.').max(2_000_000_000, 'That looks too high.');
const optionalText = (max) =>
  z.string().trim().max(max, `Keep this under ${max} characters.`).optional().nullable().transform((v) => (v ? v : null));
const years = z.number().int().min(0).max(25).optional().nullable().transform((v) => v ?? null);

export const productSchema = z
  .object({
    category: z.enum(['panel', 'inverter', 'battery'], { errorMap: () => ({ message: 'Choose a type.' }) }),
    name: z.string().trim().min(2, 'Give it a name.').max(120),
    brand: optionalText(60),
    rating: z.number({ invalid_type_error: 'Enter a number.' }).positive('Enter a number above zero.'),
    systemVoltage: z.number().int().optional().nullable(),
    batteryType: z.enum(['lithium', 'gel', 'tubular', 'agm']).optional().nullable(),
    price: naira,
    inStock: z.boolean().default(true),
    warrantyYears: years,
    description: optionalText(500),
    status: z.enum(['active', 'hidden']).default('active'),
  })
  .superRefine((p, ctx) => {
    const bad = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (p.category === 'panel') {
      if (!Number.isInteger(p.rating) || p.rating < 50 || p.rating > 1000) bad('rating', 'Panel size is in watts, between 50 and 1000 (for example 550).');
    }
    if (p.category === 'inverter') {
      if (p.rating < 0.3 || p.rating > 50) bad('rating', 'Inverter size is in kVA, between 0.3 and 50 (for example 1.5).');
      if (![12, 24, 48].includes(p.systemVoltage)) bad('systemVoltage', 'Choose 12V, 24V or 48V.');
    }
    if (p.category === 'battery') {
      if (p.rating < 0.5 || p.rating > 200) bad('rating', 'Battery size is usable kWh per unit, between 0.5 and 200 (for example 2.4).');
      if (![12, 24, 48].includes(p.systemVoltage)) bad('systemVoltage', 'Choose 12V, 24V or 48V.');
    }
  })
  .transform((p) => ({
    ...p,
    rating: Math.round(p.rating * 100) / 100,
    systemVoltage: p.category === 'panel' ? null : p.systemVoltage,
    batteryType: p.category === 'battery' ? p.batteryType ?? null : null,
  }));

const itemSchema = z.object({
  productId: z.number().int().positive(),
  qty: z.number().int().min(1, 'At least 1.').max(500, 'That is a lot. Check the quantity.'),
});

const leaseSchema = z.object({
  deposit: z.number().int().min(0).max(2_000_000_000),
  monthly: naira,
  months: z.number().int().min(6, 'At least 6 months.').max(120),
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
    rentMonthly: naira.nullable().optional(),
    eaas: eaasSchema.nullable().optional(),
    status: z.enum(['draft', 'active', 'paused']).default('draft'),
  })
  .superRefine((d, ctx) => {
    const ids = d.items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Each product can only appear once.' });
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
    leaseDeposit: d.lease?.deposit ?? null,
    leaseMonthly: d.lease?.monthly ?? null,
    leaseMonths: d.lease?.months ?? null,
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
