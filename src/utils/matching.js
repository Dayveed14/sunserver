import { priceDealEaas } from './eaas.js';
import { leaseOptions } from './lease.js';

// The rules that connect an assessment to what vendors sell. Pure functions: no database, no HTTP.
//
// An assessment tells us the minimum system the customer needs (panels kWp, inverter kVA,
// battery kWh). From that:
//   * DIY lets them pick one panel, one inverter and one battery from vendor products, but only
//     in sizes close to that minimum (never below it, and not wildly above it).
//   * Recommended shows vendor-curated deals that cover the minimum.

export const PLANS = ['buy', 'lease', 'rent', 'eaas'];

// Parts that complete a system beyond panels, inverter and battery (wiring, mounting, protection, a charge controller).
export const EXTRA_CATEGORIES = ['mounting', 'cable', 'connector', 'protection', 'surge_protection', 'distribution', 'earthing', 'controller'];
const EXTRA_SET = new Set(EXTRA_CATEGORIES);

// Which extras a system needs. A separate charge controller is only needed when the inverter does not include one.
export function neededExtras(inverter) {
  const needsController = inverter ? inverter.includesController === false : false;
  return EXTRA_CATEGORIES.filter((c) => c !== 'controller' || needsController);
}

// How much of the minimum counts as "covered", and how far above it we still call sensible.
// Panels and batteries come in fixed unit sizes, so a 5% shortfall is tolerated; inverters are not.
export const SIZING = {
  panelFloor: 0.95,
  panelCap: 1.6,
  batteryFloor: 0.95,
  batteryCap: 1.6,
  inverterCap: 1.5,
  dealOversize: 2, // a deal bigger than this multiple of the need is not a sensible match
};

const EPS = 1e-9;
const round2 = (n) => Math.round(n * 100) / 100;

// Typical Nigerian inverter systems: small ones run at 12V, mid-size at 24V, large at 48V.
export function voltageForKva(kva) {
  if (kva <= 1.5) return 12;
  if (kva <= 3.5) return 24;
  return 48;
}

export function requirementFromResult(result) {
  const s = result.solar;
  return {
    panelKwp: s.kwp,
    inverterKva: s.inverterKva,
    batteryKwh: s.batteryKwh,
    suggestedVoltage: voltageForKva(s.inverterKva),
  };
}

// Human-readable ranges for the UI ("2 to 3 kVA" style).
export function limits(req) {
  return {
    panel: { minKwp: round2(req.panelKwp * SIZING.panelFloor), maxKwp: round2(req.panelKwp * SIZING.panelCap) },
    inverter: { minKva: req.inverterKva, maxKva: round2(req.inverterKva * SIZING.inverterCap) },
    battery:
      req.batteryKwh > 0
        ? { minKwh: round2(req.batteryKwh * SIZING.batteryFloor), maxKwh: round2(req.batteryKwh * SIZING.batteryCap) }
        : { minKwh: 0, maxKwh: 0 },
  };
}

// A 24V inverter needs 12V batteries wired in pairs; a 48V inverter needs four. Returns how many
// battery units make one string, or null if the voltages cannot work together.
export function seriesCount(inverterVoltage, batteryVoltage) {
  if (!inverterVoltage || !batteryVoltage) return null;
  if (inverterVoltage % batteryVoltage !== 0) return null;
  return inverterVoltage / batteryVoltage;
}

// Allowed quantities of one product. Returns null when no quantity of it fits the customer's range.
// For batteries, pass the inverter voltage to get the right pairing step (otherwise step is 1).
export function qtyRange(category, product, req, { inverterVoltage = null } = {}) {
  const rating = Number(product.rating);
  if (!(rating > 0)) return null;

  if (category === 'inverter') {
    const ok = rating >= req.inverterKva - EPS && rating <= req.inverterKva * SIZING.inverterCap + EPS;
    return ok ? { min: 1, max: 1, step: 1 } : null;
  }

  if (category === 'panel') {
    const unitKwp = rating / 1000;
    const min = Math.ceil((req.panelKwp * SIZING.panelFloor) / unitKwp - EPS);
    const max = Math.floor((req.panelKwp * SIZING.panelCap) / unitKwp + EPS);
    return min >= 1 && max >= min ? { min, max, step: 1 } : null;
  }

  if (category === 'battery') {
    if (!(req.batteryKwh > 0)) return null;
    let step = 1;
    if (inverterVoltage) {
      step = seriesCount(inverterVoltage, product.systemVoltage);
      if (!step) return null;
    }
    const strings = (kwh) => kwh / (rating * step);
    const min = Math.ceil(strings(req.batteryKwh * SIZING.batteryFloor) - EPS) * step;
    const max = Math.floor(strings(req.batteryKwh * SIZING.batteryCap) + EPS) * step;
    return min >= step && max >= min ? { min, max, step } : null;
  }
  return null;
}

// What the DIY builder offers: every in-stock product whose size fits the customer's range.
export function diyOptions(req, products) {
  const out = { panels: [], inverters: [], batteries: [] };
  for (const product of products) {
    if (!product.inStock) continue;
    if (product.category === 'panel') {
      const qty = qtyRange('panel', product, req);
      if (qty) out.panels.push({ product, qty });
    } else if (product.category === 'inverter') {
      const qty = qtyRange('inverter', product, req);
      if (qty) out.inverters.push({ product, qty });
    } else if (product.category === 'battery') {
      const qtyByVoltage = {};
      for (const v of [12, 24, 48]) qtyByVoltage[v] = qtyRange('battery', product, req, { inverterVoltage: v });
      if (Object.values(qtyByVoltage).some(Boolean)) out.batteries.push({ product, qtyByVoltage });
    }
  }
  const byPrice = (a, b) => a.product.price - b.product.price || a.product.rating - b.product.rating;
  out.panels.sort((a, b) => a.product.price * a.qty.min - b.product.price * b.qty.min);
  out.inverters.sort(byPrice);
  out.batteries.sort(byPrice);
  return out;
}

const err = (code, message) => ({ code, message });

// Checks a DIY selection (one panel, one inverter, one battery with quantities) against the
// customer's range and prices it. `productsById` is a Map of id -> product from the database.
export function quoteDiy(req, items, productsById) {
  const errors = [];
  const lines = [];
  const byCategory = { panel: [], inverter: [], battery: [] };
  const extras = [];
  const seen = new Set();

  for (const { productId, qty } of items) {
    const product = productsById.get(Number(productId));
    if (!product || product.status !== 'active' || !product.inStock) {
      errors.push(err('PRODUCT_UNAVAILABLE', 'One of the products you picked is no longer available.'));
      continue;
    }
    if (seen.has(product.id)) {
      errors.push(err('DUPLICATE_PRODUCT', 'Each product can only be picked once. Change its quantity instead.'));
      continue;
    }
    seen.add(product.id);
    if (EXTRA_SET.has(product.category)) {
      extras.push({ product, qty });
      continue;
    }
    if (!byCategory[product.category]) {
      errors.push(err('NOT_PART_OF_SYSTEM', `${product.name} cannot be part of a custom system. You can buy it from the shop.`));
      continue;
    }
    byCategory[product.category].push({ product, qty });
  }

  const one = (category, label, required) => {
    const list = byCategory[category];
    if (list.length === 0) {
      if (required) errors.push(err(`MISSING_${category.toUpperCase()}`, `Choose ${label}.`));
      return null;
    }
    if (list.length > 1) {
      errors.push(err('TOO_MANY', `Choose just one ${category} model so everything works together.`));
      return null;
    }
    return list[0];
  };

  const panel = one('panel', 'a solar panel', true);
  const inverter = one('inverter', 'an inverter', true);
  const battery = one('battery', 'a battery', req.batteryKwh > 0);

  if (panel) {
    const range = qtyRange('panel', panel.product, req);
    if (!range) errors.push(err('PANEL_OUT_OF_RANGE', `${panel.product.name} is not a good size for what you use.`));
    else if (panel.qty < range.min || panel.qty > range.max) {
      errors.push(err('PANEL_QTY', `For your needs, choose between ${range.min} and ${range.max} of ${panel.product.name}.`));
    }
  }

  let inverterVoltage = null;
  if (inverter) {
    inverterVoltage = inverter.product.systemVoltage;
    if (!qtyRange('inverter', inverter.product, req) || inverter.qty !== 1) {
      errors.push(err('INVERTER_OUT_OF_RANGE', `${inverter.product.name} is not the right size for what you use.`));
    }
  }

  if (battery) {
    const range = qtyRange('battery', battery.product, req, { inverterVoltage });
    if (inverterVoltage && !seriesCount(inverterVoltage, battery.product.systemVoltage)) {
      errors.push(
        err(
          'VOLTAGE_MISMATCH',
          `${battery.product.name} is ${battery.product.systemVoltage}V and cannot power a ${inverterVoltage}V inverter. Pick a battery that matches.`
        )
      );
    } else if (!range) {
      errors.push(err('BATTERY_OUT_OF_RANGE', `${battery.product.name} is not a good size for what you use.`));
    } else if (battery.qty < range.min || battery.qty > range.max || battery.qty % range.step !== 0) {
      const pairing = range.step > 1 ? `, in groups of ${range.step}` : '';
      errors.push(err('BATTERY_QTY', `For your needs, choose between ${range.min} and ${range.max} of ${battery.product.name}${pairing}.`));
    }
  }

  let subtotal = 0;
  let kwp = 0;
  let kva = 0;
  let kwh = 0;
  for (const entry of [panel, inverter, battery, ...extras]) {
    if (!entry) continue;
    const { product, qty } = entry;
    const lineTotal = product.price * qty;
    subtotal += lineTotal;
    if (product.category === 'panel') kwp += (product.rating * qty) / 1000;
    if (product.category === 'inverter') kva += product.rating * qty;
    if (product.category === 'battery') kwh += product.rating * qty;
    lines.push({
      productId: product.id,
      vendorId: product.vendorId,
      vendorName: product.vendorName,
      category: product.category,
      name: product.name,
      brand: product.brand,
      rating: product.rating,
      systemVoltage: product.systemVoltage,
      qty,
      unitPrice: product.price,
      lineTotal,
    });
  }

  // Advisory only: the customer may already own some of these, so a missing part never blocks the request.
  const picked = new Set(extras.map((e) => e.product.category));
  const extrasMissing = neededExtras(inverter?.product).filter((c) => !picked.has(c));

  return {
    valid: errors.length === 0,
    errors,
    lines,
    subtotal,
    totals: { kwp: round2(kwp), kva: round2(kva), kwh: round2(kwh) },
    extrasMissing,
  };
}

// ---- Deals -----------------------------------------------------------------------------------

export function dealSpecs(items) {
  let panelKwp = 0;
  let inverterKva = 0;
  let batteryKwh = 0;
  let inverterVoltage = null;
  for (const it of items) {
    if (it.category === 'panel') panelKwp += (it.rating * it.qty) / 1000;
    if (it.category === 'inverter') {
      inverterKva += it.rating * it.qty;
      inverterVoltage = it.systemVoltage ?? inverterVoltage;
    }
    if (it.category === 'battery') batteryKwh += it.rating * it.qty;
  }
  return { panelKwp: round2(panelKwp), inverterKva: round2(inverterKva), batteryKwh: round2(batteryKwh), inverterVoltage };
}

// A deal must be a working system: panels, an inverter and a battery, with batteries that suit
// the inverter's voltage and are bought in complete strings.
export function checkDealComposition(items) {
  const errors = [];
  const by = { panel: [], inverter: [], battery: [] };
  for (const it of items) by[it.category].push(it);

  if (by.panel.length === 0) errors.push(err('MISSING_PANEL', 'Add at least one solar panel product.'));
  if (by.inverter.length === 0) errors.push(err('MISSING_INVERTER', 'Add an inverter.'));
  if (by.battery.length === 0) errors.push(err('MISSING_BATTERY', 'Add a battery.'));
  if (by.panel.length > 1) errors.push(err('TOO_MANY', 'Use one panel model per deal.'));
  if (by.inverter.length > 1) errors.push(err('TOO_MANY', 'Use one inverter model per deal.'));
  if (by.battery.length > 1) errors.push(err('TOO_MANY', 'Use one battery model per deal.'));

  if (by.inverter.length === 1 && by.battery.length === 1) {
    const inv = by.inverter[0];
    const bat = by.battery[0];
    const step = seriesCount(inv.systemVoltage, bat.systemVoltage);
    if (!step) {
      errors.push(err('VOLTAGE_MISMATCH', `${bat.name} (${bat.systemVoltage}V) cannot run a ${inv.systemVoltage}V inverter.`));
    } else if (bat.qty % step !== 0) {
      errors.push(err('BATTERY_STRINGS', `A ${inv.systemVoltage}V inverter needs batteries in groups of ${step}.`));
    }
  }
  return errors;
}

const baseOffer = { plan: null, upfront: null, monthly: null, termMonths: null, totalCost: null };

// What the customer would pay under one plan, or null if the deal does not offer that plan.
// `baseline` is what they pay for power today (monthly), used to show the saving.
export function planOffer(deal, plan, baseline, choice = {}) {
  const saving = (monthly) => Math.round(baseline.monthlyCost - monthly);

  if (plan === 'buy' && deal.buyPrice != null) {
    const net = baseline.monthlyCost - (baseline.monthlyMaintenance ?? 0);
    return {
      ...baseOffer,
      plan,
      upfront: deal.buyPrice,
      totalCost: deal.buyPrice,
      paybackMonths: net > 0 ? Math.ceil(deal.buyPrice / net) : null,
    };
  }
  if (plan === 'lease' && deal.leaseTerms && deal.buyPrice != null) {
    const options = leaseOptions(deal.buyPrice, deal.leaseTerms);
    if (options.length === 0) return null;
    // The headline is the longest plan (smallest monthly payment) unless the customer picked another.
    const pick = options.find((o) => o.months === choice.months) ?? options[options.length - 1];
    return {
      ...baseOffer,
      plan,
      upfront: pick.deposit,
      monthly: pick.monthly,
      termMonths: pick.months,
      totalCost: pick.totalPayable,
      monthlySaving: saving(pick.monthly),
      leaseOptions: options,
      cashPrice: deal.buyPrice,
    };
  }
  if (plan === 'lease' && deal.leaseMonthly != null && deal.leaseMonths != null) {
    const deposit = deal.leaseDeposit ?? 0;
    return {
      ...baseOffer,
      plan,
      upfront: deposit,
      monthly: deal.leaseMonthly,
      termMonths: deal.leaseMonths,
      totalCost: deposit + deal.leaseMonthly * deal.leaseMonths,
      monthlySaving: saving(deal.leaseMonthly),
    };
  }
  if (plan === 'rent' && deal.rentMonthly != null) {
    return { ...baseOffer, plan, upfront: deal.rentMonthly, monthly: deal.rentMonthly, monthlySaving: saving(deal.rentMonthly) };
  }
  if (plan === 'eaas' && deal.eaasTerms) {
    // Priced from the vendor's terms for this customer: a home or a business, and how much energy they use.
    const e = priceDealEaas(deal, { segment: baseline.segment ?? 'home', kwhPerMonth: baseline.kwhPerMonth ?? null });
    return {
      ...baseOffer,
      plan,
      upfront: e.installation.payAtInstall,
      monthly: e.monthly,
      termMonths: e.tenorMonths,
      totalCost: e.totalPayable + e.installation.payAtInstall,
      monthlySaving: saving(e.monthly),
      eaas: e,
      allowanceKwhPerMonth: baseline.kwhPerMonth ?? null,
      overagePerKwh: deal.eaasTerms.overagePerKwh,
    };
  }
  // Older deals with a typed-in monthly fee keep working until the vendor re-prices them.
  if (plan === 'eaas' && deal.eaasMonthly != null && deal.eaasMonths != null) {
    return {
      ...baseOffer,
      plan,
      upfront: 0,
      monthly: deal.eaasMonthly,
      termMonths: deal.eaasMonths,
      totalCost: deal.eaasMonthly * deal.eaasMonths,
      monthlySaving: saving(deal.eaasMonthly),
    };
  }
  return null;
}

export const plansOffered = (deal) => PLANS.filter((p) => planOffer(deal, p, { monthlyCost: 0 }) !== null);

// Does the deal cover what the customer needs without being absurdly oversized?
export function dealFit(req, specs) {
  const covers =
    specs.panelKwp >= req.panelKwp * SIZING.panelFloor - EPS &&
    specs.inverterKva >= req.inverterKva - EPS &&
    specs.batteryKwh >= req.batteryKwh * SIZING.batteryFloor - EPS;
  if (!covers) return null;

  const ratio = Math.max(
    specs.panelKwp / req.panelKwp,
    specs.inverterKva / req.inverterKva,
    req.batteryKwh > 0 ? specs.batteryKwh / req.batteryKwh : 0
  );
  if (ratio > SIZING.dealOversize) return null;
  return { ratio: round2(ratio), label: ratio <= 1.25 ? 'Right size' : 'Room to grow' };
}

// Deals to recommend for one plan, cheapest first. Each result carries the priced offer.
export function matchDeals(req, deals, plan, baseline) {
  const matches = [];
  for (const deal of deals) {
    if (deal.status !== 'active') continue;
    if (deal.items.some((i) => i.productStatus === 'archived')) continue;
    const specs = dealSpecs(deal.items);
    const fit = dealFit(req, specs);
    if (!fit) continue;
    const offer = planOffer(deal, plan, baseline);
    if (!offer) continue;
    matches.push({ deal, specs, fit, offer });
  }
  const key = (m) => (plan === 'buy' ? m.offer.totalCost : m.offer.monthly);
  return matches.sort((a, b) => key(a) - key(b) || a.fit.ratio - b.fit.ratio);
}
