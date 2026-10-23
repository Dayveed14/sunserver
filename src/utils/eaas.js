// Energy-as-a-Service pricing. Pure functions: no database, no HTTP.
//
// The vendor owns the equipment and the customer pays a monthly fee for the energy it supplies.
//
//   Monthly price = Capital recovery + Operating costs + Risk allowance + Platform fee
//
// * Capital recovery is an annuity at the vendor's target return, less the value the vendor can
//   still recover from the equipment when the contract ends. The return is already inside the
//   annuity, so no extra profit percentage is added on top.
// * Operating costs: maintenance, monitoring, administration, insurance, and a battery
//   replacement reserve when the contract outlasts the battery.
// * Risk allowance: the expected cost of defaults, recovering equipment and refurbishing it.
// * Platform fee: Solalium's own fee, a percentage of the all-in monthly price.
//
// Every number below is a placeholder until it is checked against real vendor and market data.
// Phase 3: move EAAS_RULES into an admin-editable table.

export const EAAS_RULES = {
  asOf: '2026-10-17',

  // Solalium's fee, as a share of the price the customer pays each month.
  platformFeePct: 0.06,

  // Vendors choose their own target return (effective, per year) inside these limits.
  annualReturn: { min: 0.1, max: 0.3, default: 0.24 },

  // Contracts must be at least 12 months so the equipment cost can be spread.
  tenorMonths: { min: 12, max: 120, suggested: [24, 36, 48, 60] },

  // Running costs.
  maintenancePctPerYear: 0.02, // of equipment cost
  insurancePctPerYear: 0.01, // theft and fire, of equipment cost
  monitoringPerMonth: 2000,
  adminPerMonth: 1500,

  // Expected losses from defaults, recovery and refurbishment, as a share of (capital + operating).
  // Lower for businesses: they have bank accounts, premises and something to lose.
  riskPct: { home: 0.05, business: 0.035 },

  // The vendor can only count on part of the equipment's remaining value: used solar is slow to sell
  // and recovery costs money. This is taken off before the value reduces the monthly price.
  residualHaircut: 0.5,

  // How long each kind of equipment lasts, in months.
  lifeMonths: { panel: 300, inverter: 120, batteryLithium: 108, batteryLead: 42 },

  // Refundable security deposit, in months of the monthly price. Does more for default risk than
  // the installation fee does.
  depositMonths: 1,
};

const round = (n) => Math.round(n);

export const batteryLife = (batteryType, rules = EAAS_RULES) =>
  !batteryType || batteryType === 'lithium' ? rules.lifeMonths.batteryLithium : rules.lifeMonths.batteryLead;

const lifeOf = (component, rules) =>
  component.category === 'panel'
    ? rules.lifeMonths.panel
    : component.category === 'inverter'
      ? rules.lifeMonths.inverter
      : batteryLife(component.batteryType, rules);

const monthlyRate = (annualReturn) => Math.pow(1 + annualReturn, 1 / 12) - 1;

// What the vendor can count on getting back for a component after `months` of use.
const recoverableValue = (component, months, rules) =>
  component.cost * Math.max(0, 1 - months / lifeOf(component, rules)) * (1 - rules.residualHaircut);

export function validateEaasTerms({ tenorMonths, annualReturn }, rules = EAAS_RULES) {
  const errors = {};
  if (!Number.isInteger(tenorMonths) || tenorMonths < rules.tenorMonths.min || tenorMonths > rules.tenorMonths.max) {
    errors.tenorMonths = `Choose a contract of ${rules.tenorMonths.min} to ${rules.tenorMonths.max} months.`;
  }
  const { min, max } = rules.annualReturn;
  if (!(annualReturn >= min - 1e-9 && annualReturn <= max + 1e-9)) {
    errors.annualReturn = `Choose a yearly return between ${Math.round(min * 100)}% and ${Math.round(max * 100)}%.`;
  }
  return errors;
}

// input:
//   components      [{ category: 'panel'|'inverter'|'battery', batteryType?, cost }]  vendor's cost per component
//   installationCost  what installing it costs the customer (0 if none)
//   installationMode  'upfront' (customer pays at install) or 'rolled' (spread over the monthly payments)
//   tenorMonths, annualReturn (e.g. 0.24), segment ('home' | 'business'), kwhPerMonth (optional)
export function computeEaas(input, rules = EAAS_RULES) {
  const {
    components,
    installationCost = 0,
    installationMode = 'upfront',
    tenorMonths: n,
    annualReturn,
    segment = 'home',
    kwhPerMonth = null,
  } = input;

  const r = monthlyRate(annualReturn);
  const equipmentCost = components.reduce((s, c) => s + c.cost, 0);
  const rolledInstall = installationMode === 'rolled' ? installationCost : 0;
  const capitalBase = equipmentCost + rolledInstall;

  // Value still recoverable when the contract ends (installation is never recoverable).
  const residual = components.reduce((s, c) => s + recoverableValue(c, n, rules), 0);

  const growth = Math.pow(1 + r, n);
  const capital = (capitalBase - residual / growth) * (r / (1 - 1 / growth));

  const maintenance = (equipmentCost * rules.maintenancePctPerYear) / 12;
  const insurance = (equipmentCost * rules.insurancePctPerYear) / 12;
  const { monitoringPerMonth: monitoring, adminPerMonth: admin } = rules;

  // The capital recovery above already pays back one battery. If the contract is longer than the
  // battery lasts, the extra wear has to be set aside as the contract runs.
  const batteries = components.filter((c) => c.category === 'battery');
  const batteryReserve =
    batteries.reduce((s, b) => s + b.cost * Math.max(0, n / batteryLife(b.batteryType, rules) - 1), 0) / n;

  const operating = maintenance + insurance + monitoring + admin + batteryReserve;
  const risk = (rules.riskPct[segment] ?? rules.riskPct.home) * (capital + operating);
  const subtotal = capital + operating + risk;
  const total = subtotal / (1 - rules.platformFeePct);
  const platformFee = total - subtotal;

  const parts = {
    capital: round(capital),
    operating: {
      maintenance: round(maintenance),
      insurance: round(insurance),
      monitoring: round(monitoring),
      admin: round(admin),
      batteryReserve: round(batteryReserve),
    },
    risk: round(risk),
    platformFee: round(platformFee),
  };
  parts.operating.total =
    parts.operating.maintenance + parts.operating.insurance + parts.operating.monitoring + parts.operating.admin + parts.operating.batteryReserve;
  // The headline price is the sum of the rounded parts, so the breakdown always adds up exactly.
  const monthly = parts.capital + parts.operating.total + parts.risk + parts.platformFee;

  // What leaving early costs: the capital still owed, less what the equipment can be recovered for.
  const owed = (k) => capitalBase * Math.pow(1 + r, k) - capital * ((Math.pow(1 + r, k) - 1) / r);
  const exitAt = (k) =>
    round(Math.max(0, owed(k) - components.reduce((s, c) => s + recoverableValue(c, k, rules), 0)));
  const exitSchedule = [];
  for (let k = 12; k < n; k += 12) exitSchedule.push({ month: k, amount: exitAt(k) });

  return {
    monthly,
    breakdown: parts,
    tenorMonths: n,
    annualReturn,
    segment,
    totalPayable: monthly * n,
    // Pay at install: the installation fee if the customer pays it upfront. Plus a refundable deposit.
    installation: { cost: round(installationCost), mode: installationMode, payAtInstall: installationMode === 'upfront' ? round(installationCost) : 0 },
    deposit: round(rules.depositMonths * monthly),
    // At the end of the contract the customer can buy the equipment for what the vendor expects it to be worth.
    buyoutAtEnd: round(residual),
    exitSchedule,
    perKwh: kwhPerMonth > 0 ? round(monthly / kwhPerMonth) : null,
    equipmentCost: round(equipmentCost),
  };
}

// Turns a deal's items into the components the engine prices. If the vendor entered their own cost for the
// whole system, each component is scaled to match; otherwise their product prices are used.
export function componentsFromItems(items, equipmentCostOverride = null) {
  const list = items.map((i) => ({ category: i.category, batteryType: i.batteryType ?? null, cost: i.price * i.qty }));
  const sum = list.reduce((s, c) => s + c.cost, 0);
  if (!equipmentCostOverride || sum <= 0) return list;
  const scale = equipmentCostOverride / sum;
  return list.map((c) => ({ ...c, cost: c.cost * scale }));
}

// The EaaS price for a vendor's deal, for a customer in `segment` using `kwhPerMonth`.
export function priceDealEaas(deal, { segment = 'home', kwhPerMonth = null } = {}, rules = EAAS_RULES) {
  const t = deal.eaasTerms;
  if (!t) return null;
  return computeEaas(
    {
      components: componentsFromItems(deal.items, t.equipmentCost),
      installationCost: t.installationCost ?? 0,
      installationMode: t.installationMode,
      tenorMonths: t.tenorMonths,
      annualReturn: t.annualReturn,
      segment,
      kwhPerMonth,
    },
    rules
  );
}
