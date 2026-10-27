import { EXTRA_CATEGORIES, SIZING, diyOptions, neededExtras } from './matching.js';

export { EXTRA_CATEGORIES, neededExtras };

// Budget checks and "complete package" rules for the assessment. Pure functions: no database, no HTTP.
//
// A solar system is more than panels, an inverter and a battery. The wiring, mounting, protection and (for plain
// inverters) a charge controller are part of the price, so the cheapest complete system includes them. Where no
// vendor lists one of them yet we add an honest allowance instead of pretending it is free.

export const EXTRAS_INFO = {
  mounting: { label: 'Mounting & racking', why: 'Holds the panels on the roof or ground.' },
  cable: { label: 'Solar cable', why: 'Carries power between the panels, inverter and battery.' },
  connector: { label: 'Connectors', why: 'Joins the panel cables safely.' },
  protection: { label: 'DC breaker / fuse', why: 'Protects the wiring from overload and short circuits.' },
  surge_protection: { label: 'Surge protection', why: 'Guards the system against lightning and power surges.' },
  distribution: { label: 'Combiner / distribution box', why: 'Brings the panel strings and breakers together in one safe box.' },
  earthing: { label: 'Earthing & lightning', why: 'Gives fault and lightning current a safe path to the ground.' },
  controller: { label: 'Charge controller', why: 'Charges the battery from the panels. Needed because this inverter has none built in.' },
};

// Used only for parts no vendor lists yet: a share of the equipment cost.
export const BOS_ALLOWANCE_PCT = 0.12;

const cheapest = (list) => list.reduce((best, p) => (best == null || p.price < best.price ? p : best), null);

// The least expensive complete system we can build from what vendors list today: panels, inverter, battery sized to the
// customer's range, plus the cheapest listing of every part the system needs.
export function cheapestSystem(req, products) {
  const opts = diyOptions(req, products);
  if (!opts.panels.length || !opts.inverters.length) return null;
  const needBattery = req.batteryKwh > 0;
  if (needBattery && !opts.batteries.length) return null;

  const panel = opts.panels[0];
  const panelCost = panel.product.price * panel.qty.min;
  let best = null;
  for (const inv of opts.inverters) {
    let battery = null;
    let batteryCost = 0;
    if (needBattery) {
      for (const b of opts.batteries) {
        const range = b.qtyByVoltage[inv.product.systemVoltage];
        if (!range) continue;
        const cost = b.product.price * range.min;
        if (battery == null || cost < batteryCost) { battery = { ...b, qty: range.min }; batteryCost = cost; }
      }
      if (!battery) continue;
    }
    const core = panelCost + inv.product.price + batteryCost;
    if (best == null || core < best.core) best = { core, inverter: inv.product, battery };
  }
  if (!best) return null;

  const needed = neededExtras(best.inverter);
  const extras = [];
  const missing = [];
  for (const category of needed) {
    const pick = cheapest(products.filter((p) => p.category === category && p.inStock));
    if (pick) extras.push({ category, product: pick, qty: 1 });
    else missing.push(category);
  }
  const extrasTotal = extras.reduce((s, e) => s + e.product.price * e.qty, 0);
  const estimatedExtras = missing.length ? Math.round((best.core * BOS_ALLOWANCE_PCT * missing.length) / needed.length) : 0;
  return {
    lines: [
      { category: 'panel', product: panel.product, qty: panel.qty.min },
      { category: 'inverter', product: best.inverter, qty: 1 },
      ...(best.battery ? [{ category: 'battery', product: best.battery.product, qty: best.battery.qty }] : []),
    ],
    coreTotal: best.core,
    extras,
    extrasTotal,
    missingExtras: missing,
    estimatedExtras,
    total: best.core + extrasTotal + estimatedExtras,
  };
}

// All-in-one products: solar kits (sized in kWp) and portable power stations (sized in kWh of storage).
// `full` means it covers the need; `partial` means it covers only part of it (still useful for a small budget).
export function allInOneOptions(req, products) {
  const out = { kits: [], portable: [] };
  for (const p of products) {
    if (!p.inStock || !(p.rating > 0)) continue;
    if (p.category === 'kit') {
      const coverage = Math.min(1, p.rating / req.panelKwp);
      const full = p.rating >= req.panelKwp * SIZING.panelFloor && p.rating <= req.panelKwp * SIZING.dealOversize;
      if (coverage >= 0.2 && p.rating <= req.panelKwp * SIZING.dealOversize) out.kits.push({ product: p, coverage: Math.round(coverage * 100), fit: full ? 'full' : 'partial' });
    } else if (p.category === 'portable_power' && req.batteryKwh > 0) {
      const coverage = Math.min(1, p.rating / req.batteryKwh);
      const full = p.rating >= req.batteryKwh * SIZING.batteryFloor && p.rating <= req.batteryKwh * 2.5;
      if (coverage >= 0.2 && p.rating <= req.batteryKwh * 2.5) out.portable.push({ product: p, coverage: Math.round(coverage * 100), fit: full ? 'full' : 'partial', peakKva: req.inverterKva });
    }
  }
  const byPrice = (a, b) => a.product.price - b.product.price;
  out.kits.sort(byPrice);
  out.portable.sort(byPrice);
  return out;
}

const outlay = (offer, plan) => (plan === 'buy' ? offer.totalCost : offer.upfront ?? 0);

// Compares the customer's budget with the cheapest way to meet their need.
//   inputs: budget (naira or null), plan, deals (matched, priced for `plan`), system (cheapestSystem or null, buy only),
//           allInOne (allInOneOptions, buy only), otherPlans ([{ plan, upfront, monthly, dealTitle }]), result (the assessment)
// status: 'no_budget' | 'ok' | 'too_small' | 'nothing_available'
export function evaluateBudget({ budget, plan, deals, system, allInOne, otherPlans = [], result }) {
  const options = [];
  for (const m of deals) options.push({ source: 'deal', id: m.deal.id, label: m.deal.title, vendor: m.deal.vendorName, price: outlay(m.offer, plan) });
  if (system) options.push({ source: 'diy', label: 'Build your own from the cheapest parts', price: system.total, includesEstimate: system.estimatedExtras > 0 });
  for (const k of allInOne?.kits ?? []) if (k.fit === 'full') options.push({ source: 'kit', id: k.product.id, label: k.product.name, vendor: k.product.vendorName, price: k.product.price });
  for (const k of allInOne?.portable ?? []) if (k.fit === 'full') options.push({ source: 'portable', id: k.product.id, label: k.product.name, vendor: k.product.vendorName, price: k.product.price });
  options.sort((a, b) => a.price - b.price);
  const cheapestOption = options[0] ?? null;

  const base = { budget: budget ?? null, plan, cheapest: cheapestOption };
  if (!cheapestOption) {
    return { ...base, status: budget == null ? 'no_budget' : 'nothing_available', shortfall: null, alternatives: alternativesFor({ budget, allInOne, otherPlans, plan }), reduceLoad: null };
  }
  if (budget == null) return { ...base, status: 'no_budget', shortfall: null, alternatives: [], reduceLoad: null };
  if (cheapestOption.price <= budget) {
    return { ...base, status: 'ok', shortfall: 0, withinBudget: options.filter((o) => o.price <= budget).length, alternatives: [], reduceLoad: null };
  }

  // Too small. Offer what a smaller budget can still do, then the load to trim.
  const factor = budget / cheapestOption.price;
  const reduceLoad = factor > 0.15
    ? { cutPct: Math.min(90, Math.max(5, Math.ceil((1 - factor) * 100 / 5) * 5)), biggest: (result?.usage?.topConsumers ?? []).slice(0, 3).map((c) => ({ name: c.name, sharePct: c.sharePct })) }
    : null;
  return {
    ...base,
    status: 'too_small',
    shortfall: cheapestOption.price - budget,
    alternatives: alternativesFor({ budget, allInOne, otherPlans, plan }),
    reduceLoad,
  };
}

function alternativesFor({ budget, allInOne, otherPlans, plan }) {
  const alts = [];
  if (plan === 'buy') {
    const partial = [...(allInOne?.kits ?? []), ...(allInOne?.portable ?? [])]
      .filter((o) => o.fit === 'partial' && (budget == null || o.product.price <= budget))
      .sort((a, b) => b.coverage - a.coverage || a.product.price - b.product.price)
      .slice(0, 3);
    for (const o of partial) alts.push({ type: 'partial', id: o.product.id, category: o.product.category, label: o.product.name, vendor: o.product.vendorName, price: o.product.price, coveragePct: o.coverage });
  }
  for (const o of otherPlans) {
    if (budget != null && o.upfront > budget) continue;
    alts.push({ type: 'plan', plan: o.plan, label: o.dealTitle, upfront: o.upfront, monthly: o.monthly });
  }
  return alts;
}
