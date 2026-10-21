import { HttpError } from '../../lib/httpError.js';
import { eaasOffered } from '../../config/launch.js';
import { EAAS_RULES, computeEaas } from '../marketplace/eaas.js';
import { HOURS_BY_KEY } from './catalog/hours.js';

const BAND_ORDER = ['A', 'B', 'C', 'D', 'E'];
const STANDARD_KVA = [1, 1.5, 2, 3, 3.5, 5, 7.5, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500];
const DAYS = 30;

const r0 = (n) => Math.round(n);
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Turns "what the customer ticked" into energy use and cost estimates.
 *
 * input: { segment, disco, supplyBand, items: [{ applianceId, variantId, qty, hoursKey? }] }
 * deps:  { catalogs, assumptions }
 *
 * The browser only sends IDs and counts. Wattage, duty cycles and prices all come from the
 * server, so a tampered request can't change the maths.
 */
export function estimate(input, { catalogs, assumptions: A }) {
  const catalog = catalogs[input.segment];
  if (!catalog) throw new HttpError(400, 'UNKNOWN_SEGMENT', 'Choose home or business.');
  const disco = A.discos.find((d) => d.id === input.disco);
  if (!disco) throw new HttpError(400, 'UNKNOWN_DISCO', 'We do not recognise that electricity company.');

  const appliances = new Map(catalog.appliances.map((ap) => [ap.id, ap]));

  // ---- 1. Per-line energy use ------------------------------------------------------------
  const merged = new Map();
  for (const item of input.items) {
    const key = `${item.applianceId}|${item.variantId}|${item.hoursKey ?? ''}`;
    const existing = merged.get(key);
    if (existing) existing.qty += item.qty;
    else merged.set(key, { ...item });
  }

  const lines = [];
  for (const item of merged.values()) {
    const ap = appliances.get(item.applianceId);
    if (!ap) throw new HttpError(400, 'UNKNOWN_APPLIANCE', `Unknown item: ${item.applianceId}`);
    const variant = ap.variants.find((vr) => vr.id === item.variantId);
    if (!variant) throw new HttpError(400, 'UNKNOWN_VARIANT', `Unknown option for ${ap.name}.`);

    let hours;
    let hoursLabel;
    if (ap.hoursMode === 'fixed') {
      hours = ap.fixedHours;
      hoursLabel = 'All day & night';
    } else {
      const opt = HOURS_BY_KEY.get(item.hoursKey ?? ap.defaultHours);
      if (!opt) throw new HttpError(400, 'UNKNOWN_HOURS', `Unknown hours option for ${ap.name}.`);
      hours = opt.hours;
      hoursLabel = opt.label;
    }
    if (item.qty > ap.maxQty) {
      throw new HttpError(400, 'QTY_TOO_HIGH', `${ap.name}: that quantity is higher than we support (${ap.maxQty}).`);
    }

    const duty = variant.dutyCycle ?? ap.dutyCycle;
    const surge = variant.surge ?? ap.surge;
    const runningW = variant.watts * item.qty;

    lines.push({
      applianceId: ap.id,
      name: ap.name,
      variantLabel: variant.label,
      qty: item.qty,
      hours,
      hoursLabel,
      runningW,
      surgeExtraW: variant.watts * (surge - 1), // extra draw for ONE unit starting up
      daytimeShare: ap.daytimeShare,
      kwhPerDay: (runningW * hours * duty) / 1000,
    });
  }

  const kwhPerDay = lines.reduce((s, l) => s + l.kwhPerDay, 0);
  const kwhPerMonth = kwhPerDay * DAYS;
  const daytimeKwh = lines.reduce((s, l) => s + l.kwhPerDay * l.daytimeShare, 0);
  const nightKwh = kwhPerDay - daytimeKwh;

  // ---- 2. Load and inverter sizing -------------------------------------------------------
  const S = A.sizing;
  const connectedW = lines.reduce((s, l) => s + l.runningW, 0);
  const concurrentW = connectedW * S.diversity[input.segment];
  const peakW = concurrentW + Math.max(...lines.map((l) => l.surgeExtraW));
  // Size for sustained load with headroom, and make sure the start-up surge fits within ~2x rating.
  const byLoad = (concurrentW * S.inverterHeadroom) / S.powerFactor / 1000;
  const bySurge = peakW / 2 / S.powerFactor / 1000;
  const neededKva = Math.max(byLoad, bySurge);
  const inverterKva = STANDARD_KVA.find((k) => k >= neededKva) ?? Math.ceil(neededKva / 50) * 50;

  // ---- 3. Generator ---------------------------------------------------------------------
  const gen = A.generator[input.segment];
  const generatorCostPerKwh = A.fuelPricePerLitre * gen.litresPerKwh * (1 + A.generator.maintenancePct);
  const generator = {
    fuel: gen.fuel,
    litresPerDay: r1(kwhPerDay * gen.litresPerKwh),
    litresPerMonth: r0(kwhPerMonth * gen.litresPerKwh),
    costPerKwh: r0(generatorCostPerKwh),
    dailyCost: r0(kwhPerDay * generatorCostPerKwh),
    monthlyCost: r0(kwhPerMonth * generatorCostPerKwh),
  };

  // ---- 4. Grid bands (grid for the hours you get, generator for the gaps) -------------------
  const tariffs = A.tariffs[disco.id] ?? A.tariffs.default;
  const bands = BAND_ORDER.map((band) => {
    const { typicalHours, label } = A.bands[band];
    const gridShare = typicalHours / 24; // assumes use is spread evenly through the day
    const gridKwh = kwhPerMonth * gridShare;
    const genKwh = kwhPerMonth - gridKwh;
    const gridCost = gridKwh * tariffs[band];
    const generatorCost = genKwh * generatorCostPerKwh;
    return {
      band,
      hoursLabel: label,
      hoursPerDay: typicalHours,
      tariff: tariffs[band],
      gridKwhMonth: r0(gridKwh),
      generatorKwhMonth: r0(genKwh),
      gridCost: r0(gridCost),
      generatorCost: r0(generatorCost),
      totalMonthly: r0(gridCost + generatorCost),
    };
  });

  const selectedBand = input.supplyBand ? bands.find((b) => b.band === input.supplyBand) : null;
  const current = selectedBand
    ? {
        kind: 'grid-plus-generator',
        band: selectedBand.band,
        label: `Band ${selectedBand.band} electricity + generator for the gaps`,
        monthlyCost: selectedBand.totalMonthly,
      }
    : {
        kind: 'generator-only',
        band: null,
        label: 'Running everything on a generator',
        monthlyCost: generator.monthlyCost,
      };

  // ---- 5. Solar system -------------------------------------------------------------------
  const P = A.solar;
  const pvDailyNeed = daytimeKwh + nightKwh / P.batteryRoundTrip;
  const rawKwp = pvDailyNeed / (disco.peakSunHours * P.performanceRatio);
  const panels = Math.max(2, Math.ceil((rawKwp * 1000) / P.panelWatts));
  const kwp = (panels * P.panelWatts) / 1000;
  const batteryKwh = nightKwh > 0.05 ? Math.ceil((nightKwh / P.batteryDepthOfDischarge) * 2) / 2 : 0;

  const panelCost = kwp * P.pvCostPerKwp;
  const inverterCost = inverterKva * P.inverterCostPerKva;
  const batteryCost = batteryKwh * P.batteryCostPerKwh;
  const subtotal = panelCost + inverterCost + batteryCost;
  const installCost = subtotal * P.installPct;
  const systemCost = Math.round((subtotal + installCost) / 1000) * 1000;
  const monthlyMaintenance = r0((systemCost * P.annualMaintenancePct) / 12);

  const paybackMonths = (baseline) => {
    const saving = baseline - monthlyMaintenance;
    return saving > 0 ? Math.ceil(systemCost / saving) : null;
  };

  const solar = {
    panels,
    panelWatts: P.panelWatts,
    kwp: r2(kwp),
    batteryKwh,
    inverterKva,
    peakSunHours: disco.peakSunHours,
    systemCost,
    breakdown: {
      panels: r0(panelCost),
      inverter: r0(inverterCost),
      battery: r0(batteryCost),
      installation: r0(installCost),
    },
    monthlyMaintenance,
    paybackMonthsVsCurrent: paybackMonths(current.monthlyCost),
    paybackMonthsVsGenerator: paybackMonths(generator.monthlyCost),
  };

  // ---- 6. Ways to get it: buy, lease, rent, energy-as-a-service -----------------------------
  const F = A.financing;
  const baseline = current.monthlyCost;
  const horizon = 60;

  const leaseDeposit = systemCost * F.lease.depositPct;
  const leaseMonthly = (systemCost * (1 + F.lease.markupPct) - leaseDeposit) / F.lease.termMonths;
  const rentMonthly = systemCost * F.rent.monthlyPct;
  // Energy as a service uses the same pricing rules vendors use: annuity on the equipment at a target return,
  // plus running costs, a risk allowance and Sunledger's fee. See marketplace/eaas.js.
  const eaasQuote = computeEaas({
    components: [
      { category: 'panel', cost: panelCost },
      { category: 'inverter', cost: inverterCost },
      { category: 'battery', cost: batteryCost, batteryType: 'lithium' },
    ],
    installationCost: installCost,
    installationMode: F.eaas.installationMode,
    tenorMonths: F.eaas.termMonths,
    annualReturn: EAAS_RULES.annualReturn.default,
    segment: input.segment,
    kwhPerMonth,
  });
  const eaasMonthly = eaasQuote.monthly;

  const options = {
    buy: {
      key: 'buy',
      upfront: systemCost,
      monthlyCostAfter: monthlyMaintenance,
      total5yr: r0(systemCost + monthlyMaintenance * horizon),
    },
    lease: {
      key: 'lease',
      upfront: r0(leaseDeposit),
      monthly: r0(leaseMonthly),
      termMonths: F.lease.termMonths,
      monthlyCostAfter: r0(leaseMonthly + monthlyMaintenance),
      total5yr: r0(leaseDeposit + leaseMonthly * F.lease.termMonths + monthlyMaintenance * horizon),
    },
    rent: {
      key: 'rent',
      upfront: r0(rentMonthly), // one month in advance
      monthly: r0(rentMonthly),
      monthlyCostAfter: r0(rentMonthly),
      total5yr: r0(rentMonthly * horizon),
    },
    eaas: {
      key: 'eaas',
      upfront: eaasQuote.installation.payAtInstall,
      monthly: r0(eaasMonthly),
      termMonths: F.eaas.termMonths,
      perKwh: r0(eaasMonthly / kwhPerMonth),
      monthlyCostAfter: r0(eaasMonthly),
      total5yr: r0(eaasMonthly * F.eaas.termMonths),
    },
  };
  for (const o of Object.values(options)) o.monthlySaving = r0(baseline - o.monthlyCostAfter);

  // Energy as a service is left out entirely for customers it is not offered to (config/launch.js).
  const offered = eaasOffered(input.segment) ? options : Object.fromEntries(Object.entries(options).filter(([k]) => k !== 'eaas'));
  const lowestTotalKey = Object.values(offered).reduce((best, o) => (o.total5yr < best.total5yr ? o : best)).key;
  const saves = (k) => options[k].monthlySaving > 0;

  // If buying would take more than 7 years to pay back (or never does), be honest about it
  // rather than steering the customer toward an option that will not help them.
  const solarMayNotPayBack = solar.paybackMonthsVsCurrent === null || solar.paybackMonthsVsCurrent > 84;

  // Energy as a service is only offered to the kinds of customer set in config/launch.js (businesses for now).
  const withEaas = eaasOffered(input.segment);
  const pick = (order) => order.filter((k) => withEaas || k !== 'eaas').find(saves) ?? null;
  let suggested = null;
  if (solarMayNotPayBack) {
    suggested = null;
  } else if (input.segment === 'home') {
    suggested = pick(['eaas', 'lease', 'rent']);
  } else if (solar.paybackMonthsVsCurrent <= 36) {
    suggested = 'buy';
  } else {
    suggested = pick(['lease', 'eaas', 'rent']);
  }

  // ---- 7. Output ---------------------------------------------------------------------------
  const byAppliance = new Map();
  for (const l of lines) byAppliance.set(l.applianceId, (byAppliance.get(l.applianceId) ?? 0) + l.kwhPerDay);
  const topConsumers = [...byAppliance.entries()]
    .map(([id, kwh]) => ({
      applianceId: id,
      name: appliances.get(id).name,
      kwhPerDay: r2(kwh),
      sharePct: r0((kwh / kwhPerDay) * 100),
    }))
    .sort((a, b) => b.kwhPerDay - a.kwhPerDay)
    .slice(0, 6);

  return {
    segment: input.segment,
    disco: { id: disco.id, name: disco.name },
    supplyBand: input.supplyBand ?? null,
    usage: {
      kwhPerDay: r2(kwhPerDay),
      kwhPerMonth: r0(kwhPerMonth),
      connectedKw: r1(connectedW / 1000),
      peakKw: r1(peakW / 1000),
      inverterKva,
      daytimeKwhPerDay: r2(daytimeKwh),
      nightKwhPerDay: r2(nightKwh),
      topConsumers,
      lines: lines.map((l) => ({
        applianceId: l.applianceId,
        name: l.name,
        variantLabel: l.variantLabel,
        qty: l.qty,
        hoursLabel: l.hoursLabel,
        kwhPerDay: r2(l.kwhPerDay),
      })),
    },
    generator,
    grid: { bands, selectedBand: selectedBand?.band ?? null },
    current,
    solar,
    options: { ...offered, suggested, lowestTotalKey },
    flags: {
      needsSiteAudit: connectedW / 1000 > S.siteAuditKw,
      solarMayNotPayBack,
    },
    assumptions: {
      asOf: A.asOf,
      fuel: gen.fuel,
      fuelPricePerLitre: A.fuelPricePerLitre,
      litresPerKwh: gen.litresPerKwh,
      generatorMaintenancePct: A.generator.maintenancePct,
      generatorCostPerKwh: generator.costPerKwh,
      tariffs,
      tariffsVerified: A.tariffsVerified,
      peakSunHours: disco.peakSunHours,
      performanceRatio: P.performanceRatio,
      lease: F.lease,
      rent: F.rent,
      eaas: { ...F.eaas, annualReturn: EAAS_RULES.annualReturn.default, platformFeePct: EAAS_RULES.platformFeePct },
      usageSpread: 'Electricity use is assumed to be spread evenly through the day.',
    },
  };
}
