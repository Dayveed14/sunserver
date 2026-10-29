import { EAAS_RULES } from './eaas.js';
import { ASSUMPTIONS } from './pricing.js';
import { DELIVERY_RULES } from './delivery.js';
import { SLA_RULES } from './sla.js';
import { LEASE_RULES } from './lease.js';
import { FEE_RULES } from './fees.js';
import { INSTALL_RULES } from './installRules.js';

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
  ['eaasPlatformFee', 'Solariun fee', 'Energy as a service', 'pct', 'E', ['platformFeePct'], 0, 0.25, 'of the monthly price'],
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
  // How Solariun earns
  ['vendorRegistrationFee', 'Vendor registration fee (one-time)', 'Solariun fees', 'naira', 'F', ['vendorRegistrationFee'], 0, 5000000, '₦ once per vendor, when registration is switched to paid'],
  ['vendorSubscriptionSeller', 'Monthly subscription, sellers', 'Solariun fees', 'naira', 'F', ['vendorSubscriptionSeller'], 0, 5000000, '₦ per month. 0 = no subscription for sellers'],
  ['vendorSubscriptionCompany', 'Monthly subscription, companies', 'Solariun fees', 'naira', 'F', ['vendorSubscriptionCompany'], 0, 5000000, '₦ per month. 0 = no subscription for companies'],
  ['subscriptionGraceDays', 'Days of grace after a subscription runs out', 'Solariun fees', 'number', 'F', ['subscriptionGraceDays'], 0, 60, 'days before listings are hidden'],
  ['customerServicePct', 'Service charge added for the customer', 'Solariun fees', 'pct', 'F', ['customerServicePct'], 0, 0.3, 'of the items bought'],
  ['vendorCommissionPct', 'Platform fee held back from the vendor', 'Solariun fees', 'pct', 'F', ['vendorCommissionPct'], 0, 0.3, 'of the items sold'],
  // Installation by a Solariun installer
  ['installPriceB1', 'Installation, up to 1 kW', 'Installation (installer jobs)', 'naira', 'I', ['prices', 'b1'], 5000, 5000000, '₦ the customer pays'],
  ['installPriceB2', 'Installation, over 1 kW to 3 kW', 'Installation (installer jobs)', 'naira', 'I', ['prices', 'b2'], 5000, 5000000, '₦ the customer pays'],
  ['installPriceB3', 'Installation, over 3 kW to 5 kW', 'Installation (installer jobs)', 'naira', 'I', ['prices', 'b3'], 5000, 5000000, '₦ the customer pays'],
  ['installPriceB4', 'Installation, over 5 kW to 10 kW', 'Installation (installer jobs)', 'naira', 'I', ['prices', 'b4'], 5000, 10000000, '₦ the customer pays'],
  ['installPriceB5', 'Installation, over 10 kW to 20 kW', 'Installation (installer jobs)', 'naira', 'I', ['prices', 'b5'], 5000, 20000000, '₦ the customer pays'],
  ['installPriceB6', 'Installation, over 20 kW to 50 kW', 'Installation (installer jobs)', 'naira', 'I', ['prices', 'b6'], 5000, 50000000, '₦ the customer pays'],
  ['installPayoutPct', 'Installer share of the fee', 'Installation (installer jobs)', 'pct', 'I', ['payoutPct'], 0.1, 0.95, 'of the installation fee'],
  ['installAlertMinutes', 'Alert the admin if nobody accepts within', 'Installation (installer jobs)', 'number', 'I', ['alertMinutes'], 5, 2880, 'minutes'],
  ['installAutoCloseHours', 'Close a finished job by itself after', 'Installation (installer jobs)', 'number', 'I', ['autoCloseHours'], 1, 168, 'hours, if the customer does not confirm'],
  // Lease to own: pay small small
  ['leaseMarkup3', 'Mark-up on a 3-month plan', 'Lease to own (pay small small)', 'pct', 'L', ['markupPct', '3'], 0, 1, 'over the cash price'],
  ['leaseMarkup4', 'Mark-up on a 4-month plan', 'Lease to own (pay small small)', 'pct', 'L', ['markupPct', '4'], 0, 1, 'over the cash price'],
  ['leaseMarkup6', 'Mark-up on a 6-month plan', 'Lease to own (pay small small)', 'pct', 'L', ['markupPct', '6'], 0, 1, 'over the cash price'],
  ['leaseMarkup12', 'Mark-up on a 12-month plan', 'Lease to own (pay small small)', 'pct', 'L', ['markupPct', '12'], 0, 1.5, 'over the cash price'],
  // Delivery prices
  ['deliveryRoadFactor', 'Road distance vs straight line', 'Delivery pricing', 'number', 'D', ['roadFactor'], 1, 2.5, 'times the straight-line distance'],
  ['deliveryBaseFee', 'Base fee per trip', 'Delivery pricing', 'naira', 'D', ['baseFee'], 0, 20000, '₦ per trip'],
  ['deliveryPerKm', 'Price per kilometre', 'Delivery pricing', 'naira', 'D', ['perKm'], 0, 2000, '₦ per km'],
  ['deliveryMinFee', 'Lowest delivery fee', 'Delivery pricing', 'naira', 'D', ['minFee'], 0, 50000, '₦'],
  ['deliveryMaxFee', 'Highest delivery fee', 'Delivery pricing', 'naira', 'D', ['maxFee'], 1000, 200000, '₦'],
  // Delivery times
  ['slaAcceptMinutes', 'Time allowed for a vendor to accept', 'Delivery times', 'number', 'S', ['acceptMinutes'], 5, 240, 'minutes'],
  ['slaPrepMinutes', 'Time to prepare an order', 'Delivery times', 'number', 'S', ['prepBaseMinutes'], 10, 600, 'minutes'],
  ['slaPrepExtra', 'Extra preparation for each further item type', 'Delivery times', 'number', 'S', ['prepPerExtraLineMinutes'], 0, 120, 'minutes'],
  ['slaRiderArrival', 'Time for a rider to reach the vendor', 'Delivery times', 'number', 'S', ['riderArrivalMinutes'], 5, 240, 'minutes'],
  ['slaSpeedCentral', 'Average speed, Central areas', 'Delivery times', 'number', 'S', ['speedKph', 'Central'], 5, 80, 'km per hour'],
  ['slaSpeedInner', 'Average speed, Inner areas', 'Delivery times', 'number', 'S', ['speedKph', 'Inner'], 5, 80, 'km per hour'],
  ['slaSpeedOuter', 'Average speed, Outer areas', 'Delivery times', 'number', 'S', ['speedKph', 'Outer'], 5, 90, 'km per hour'],
  ['slaRushMultiplier', 'Rush-hour slowdown', 'Delivery times', 'number', 'S', ['rushHourMultiplier'], 1, 4, 'times longer'],
  ['slaBufferPct', 'Cushion for delays', 'Delivery times', 'pct', 'S', ['bufferPct'], 0, 1.5, 'of the working time'],
  ['slaBufferFixed', 'Extra cushion', 'Delivery times', 'number', 'S', ['bufferFixedMinutes'], 0, 240, 'minutes'],
  ['slaAutoReceive', 'Auto-confirm delivery after', 'Delivery times', 'number', 'S', ['autoReceiveHours'], 1, 168, 'hours'],
];

const read = (obj, path) => path.reduce((o, k) => o[k], obj);
function write(obj, path, value) {
  const parent = path.slice(0, -1).reduce((o, k) => o[k], obj);
  parent[path.at(-1)] = value;
}

// A registry works on the objects it is given, so tests can use copies and production uses the real ones.
export function createSettingsRegistry({ assumptions, eaasRules, deliveryRules = structuredClone(DELIVERY_RULES), slaRules = structuredClone(SLA_RULES), leaseRules = structuredClone(LEASE_RULES), feeRules = structuredClone(FEE_RULES), installRules = structuredClone(INSTALL_RULES) }) {
  const roots = { A: assumptions, E: eaasRules, D: deliveryRules, S: slaRules, L: leaseRules, F: feeRules, I: installRules };
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
    if (!errors.deliveryMinFee && !errors.deliveryMaxFee && values.deliveryMinFee > values.deliveryMaxFee) {
      errors.deliveryMaxFee = 'The highest fee must be at least the lowest.';
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

// Cross-checks between settings that depend on each other.
export const settingsRegistry = createSettingsRegistry({
  assumptions: ASSUMPTIONS,
  eaasRules: EAAS_RULES,
  deliveryRules: DELIVERY_RULES,
  slaRules: SLA_RULES,
  leaseRules: LEASE_RULES,
  feeRules: FEE_RULES,
  installRules: INSTALL_RULES,
});
