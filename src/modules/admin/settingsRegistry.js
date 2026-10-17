import { EAAS_RULES } from '../marketplace/eaas.js';
import { ASSUMPTIONS } from '../analysis/pricing.js';

// The numbers an admin may change without a code release. Each entry points at a value inside the live
// pricing objects, so a saved change takes effect on the next assessment or offer. Percentages are stored as
// fractions (0.06 = 6%). Limits stop a typo (an extra zero) from wrecking every price on the site.
const DEFS = [
  // Fuel and electricity
  ['fuelPricePerLitre', 'Fuel price', 'Fuel and electricity', 'naira', 'A', ['fuelPricePerLitre'], 300, 10000, '₦ per litre'],
  ['tariffA', 'Grid tariff, Band A', 'Fuel and electricity', 'naira', 'A', ['tariffs', 'default', 'A'], 1, 1000, '₦ per kWh'],
  ['tariffB', 'Grid tariff, Band B', 'Fuel and electricity', 'naira', 'A', ['tariffs', 'default', 'B'], 1, 1000, '₦ per kWh'],
  ['tariffC', 'Grid tariff, Band C', 'Fuel and electricity', 'naira', 'A', ['tariffs', 'default', 'C'], 1, 1000, '₦ per kWh'],
  ['tariffD', 'Grid tariff, Band D', 'Fuel and electricity', 'naira', 'A', ['tariffs', 'default', 'D'], 1, 1000, '₦ per kWh'],
  ['tariffE', 'Grid tariff, Band E', 'Fuel and electricity', 'naira', 'A', ['tariffs', 'default', 'E'], 1, 1000, '₦ per kWh'],
  // Solar prices used in the free assessment
  ['pvCostPerKwp', 'Solar panels', 'Solar prices (free assessment)', 'naira', 'A', ['solar', 'pvCostPerKwp'], 50000, 5000000, '₦ per kWp'],
  ['inverterCostPerKva', 'Inverter', 'Solar prices (free assessment)', 'naira', 'A', ['solar', 'inverterCostPerKva'], 20000, 3000000, '₦ per kVA'],
  ['batteryCostPerKwh', 'Lithium battery', 'Solar prices (free assessment)', 'naira', 'A', ['solar', 'batteryCostPerKwh'], 50000, 5000000, '₦ per kWh'],
  ['installPct', 'Installation', 'Solar prices (free assessment)', 'pct', 'A', ['solar', 'installPct'], 0, 0.5, 'of equipment cost'],
  ['annualMaintenancePct', 'Yearly maintenance', 'Solar prices (free assessment)', 'pct', 'A', ['solar', 'annualMaintenancePct'], 0, 0.1, 'of system cost'],
  // Other ways to pay, as shown in the free assessment
  ['leaseMarkupPct', 'Lease mark-up', 'Lease and rent (free assessment)', 'pct', 'A', ['financing', 'lease', 'markupPct'], 0, 1.5, 'over system cost'],
  ['leaseDepositPct', 'Lease deposit', 'Lease and rent (free assessment)', 'pct', 'A', ['financing', 'lease', 'depositPct'], 0, 0.6, 'of system cost'],
  ['rentMonthlyPct', 'Rent per month', 'Lease and rent (free assessment)', 'pct', 'A', ['financing', 'rent', 'monthlyPct'], 0.005, 0.15, 'of system cost'],
  // Energy as a service (applies to vendors and the free assessment)
  ['eaasPlatformFee', 'Sunledger fee', 'Energy as a service', 'pct', 'E', ['platformFeePct'], 0, 0.25, 'of the monthly price'],
  ['eaasReturnMin', 'Lowest return a vendor may set', 'Energy as a service', 'pct', 'E', ['annualReturn', 'min'], 0, 0.6, 'a year'],
  ['eaasReturnMax', 'Highest return a vendor may set', 'Energy as a service', 'pct', 'E', ['annualReturn', 'max'], 0.02, 0.8, 'a year'],
  ['eaasReturnDefault', 'Return used in the free assessment', 'Energy as a service', 'pct', 'E', ['annualReturn', 'default'], 0, 0.6, 'a year'],
  ['eaasMaintenance', 'Maintenance', 'Energy as a service', 'pct', 'E', ['maintenancePctPerYear'], 0, 0.1, 'of equipment cost a year'],
  ['eaasInsurance', 'Insurance', 'Energy as a service', 'pct', 'E', ['insurancePctPerYear'], 0, 0.1, 'of equipment cost a year'],
  ['eaasMonitoring', 'Monitoring', 'Energy as a service', 'naira', 'E', ['monitoringPerMonth'], 0, 100000, '₦ per month'],
  ['eaasAdmin', 'Administration', 'Energy as a service', 'naira', 'E', ['adminPerMonth'], 0, 100000, '₦ per month'],
  ['eaasRiskHome', 'Risk allowance, homes', 'Energy as a service', 'pct', 'E', ['riskPct', 'home'], 0, 0.4, 'of cost'],
  ['eaasRiskBusiness', 'Risk allowance, businesses', 'Energy as a service', 'pct', 'E', ['riskPct', 'business'], 0, 0.4, 'of cost'],
  ['eaasResidualHaircut', 'Resale value not counted on', 'Energy as a service', 'pct', 'E', ['residualHaircut'], 0, 1, 'of leftover value'],
  ['eaasDepositMonths', 'Refundable deposit', 'Energy as a service', 'number', 'E', ['depositMonths'], 0, 3, 'months of payments'],
];

const read = (obj, path) => path.reduce((o, k) => o[k], obj);
function write(obj, path, value) {
  const parent = path.slice(0, -1).reduce((o, k) => o[k], obj);
  parent[path.at(-1)] = value;
}

// A registry works on the objects it is given, so tests can use copies and production uses the real ones.
export function createSettingsRegistry({ assumptions, eaasRules }) {
  const roots = { A: assumptions, E: eaasRules };
  const defs = DEFS.map(([key, label, group, unit, root, path, min, max, note]) => ({ key, label, group, unit, root, path, min, max, note }));
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const defaults = Object.fromEntries(defs.map((d) => [d.key, read(roots[d.root], d.path)]));
  const current = () => Object.fromEntries(defs.map((d) => [d.key, read(roots[d.root], d.path)]));

  // Checks a full set of values. Returns { key: message } for anything wrong.
  function validate(values) {
    const errors = {};
    for (const d of defs) {
      const v = values[d.key];
      if (typeof v !== 'number' || !Number.isFinite(v)) errors[d.key] = 'Enter a number.';
      else if (v < d.min || v > d.max) errors[d.key] = `Use a value between ${d.min} and ${d.max}.`;
    }
    if (!errors.eaasReturnMin && !errors.eaasReturnMax && values.eaasReturnMin >= values.eaasReturnMax) {
      errors.eaasReturnMax = 'The highest return must be above the lowest.';
    }
    if (!errors.eaasReturnDefault && !errors.eaasReturnMin && !errors.eaasReturnMax) {
      if (values.eaasReturnDefault < values.eaasReturnMin || values.eaasReturnDefault > values.eaasReturnMax) {
        errors.eaasReturnDefault = 'Keep this between the lowest and highest return.';
      }
    }
    return errors;
  }

  return {
    defs,
    has: (key) => byKey.has(key),
    defaults,
    current,
    validate,
    // Puts values into the live pricing objects. Call validate first.
    apply(values) {
      for (const d of defs) if (d.key in values) write(roots[d.root], d.path, values[d.key]);
      eaasRules.asOf = new Date().toISOString().slice(0, 10);
    },
    reset() {
      for (const d of defs) write(roots[d.root], d.path, defaults[d.key]);
    },
  };
}

export const settingsRegistry = createSettingsRegistry({ assumptions: ASSUMPTIONS, eaasRules: EAAS_RULES });
