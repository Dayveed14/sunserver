import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../src/lib/httpError.js';
import { estimate } from '../src/utils/calculator.js';
import { catalogs } from '../src/utils/catalog/index.js';
import { HOURS_BY_KEY } from '../src/utils/catalog/hours.js';
import { ASSUMPTIONS } from '../src/utils/pricing.js';

const run = (input, assumptions = ASSUMPTIONS) => estimate(input, { catalogs, assumptions });
const base = { segment: 'home', disco: 'aedc', supplyBand: null };

// Small hand-made catalogue so the arithmetic below is easy to check by hand.
const fixture = {
  home: {
    appliances: [
      {
        id: 'tv', name: 'TV', hoursMode: 'chips', defaultHours: 'h4', fixedHours: 24, dutyCycle: 1, surge: 1,
        daytimeShare: 0.5, maxQty: 5, variants: [{ id: '50', label: '50 inch', watts: 100 }],
      },
      {
        id: 'fridge', name: 'Fridge', hoursMode: 'fixed', defaultHours: 'h4', fixedHours: 24, dutyCycle: 0.5, surge: 4,
        daytimeShare: 0.5, maxQty: 5, variants: [{ id: 'one', label: 'One door', watts: 100 }],
      },
    ],
  },
};
const runFixture = (items) =>
  estimate({ ...base, items }, { catalogs: fixture, assumptions: ASSUMPTIONS });

describe('energy maths', () => {
  it('multiplies watts x quantity x hours', () => {
    // 100 W x 2 TVs x 4 h (the "3-5 hrs" range) = 0.8 kWh a day
    const r = runFixture([{ applianceId: 'tv', variantId: '50', qty: 2, hoursKey: 'h4' }]);
    assert.equal(r.usage.kwhPerDay, 0.8);
    assert.equal(r.usage.kwhPerMonth, 24);
  });

  it('applies the duty cycle to always-on compressors', () => {
    // 100 W x 24 h x 0.5 duty = 1.2 kWh a day, and the customer never supplies hours
    const r = runFixture([{ applianceId: 'fridge', variantId: 'one', qty: 1 }]);
    assert.equal(r.usage.kwhPerDay, 1.2);
  });

  it('merges repeated lines for the same item', () => {
    const r = runFixture([
      { applianceId: 'tv', variantId: '50', qty: 1, hoursKey: 'h4' },
      { applianceId: 'tv', variantId: '50', qty: 1, hoursKey: 'h4' },
    ]);
    assert.equal(r.usage.kwhPerDay, 0.8);
    assert.equal(r.usage.lines.length, 1);
  });

  it('splits usage into day and night for battery sizing', () => {
    const r = runFixture([{ applianceId: 'tv', variantId: '50', qty: 1, hoursKey: 'h4' }]);
    assert.equal(r.usage.daytimeKwhPerDay + r.usage.nightKwhPerDay, r.usage.kwhPerDay);
    assert.equal(r.usage.daytimeKwhPerDay, 0.2);
  });

  it('rejects things we do not know, instead of guessing', () => {
    const bad = (item) => () => runFixture([item]);
    assert.throws(bad({ applianceId: 'nope', variantId: '50', qty: 1 }), (e) => e instanceof HttpError && e.code === 'UNKNOWN_APPLIANCE');
    assert.throws(bad({ applianceId: 'tv', variantId: 'nope', qty: 1 }), (e) => e.code === 'UNKNOWN_VARIANT');
    assert.throws(bad({ applianceId: 'tv', variantId: '50', qty: 1, hoursKey: 'h99' }), (e) => e.code === 'UNKNOWN_HOURS');
    assert.throws(bad({ applianceId: 'tv', variantId: '50', qty: 99 }), (e) => e.code === 'QTY_TOO_HIGH');
    assert.throws(() => run({ ...base, disco: 'nowhere', items: [] }), (e) => e.code === 'UNKNOWN_DISCO');
  });
});

describe('costs', () => {
  const family = catalogs.home.presets.find((p) => p.id === 'family').items;
  const r = run({ ...base, items: family });

  it('prices the generator from litres x fuel price, plus servicing', () => {
    const g = ASSUMPTIONS.generator.home;
    const perKwh = ASSUMPTIONS.fuelPricePerLitre * g.litresPerKwh * (1 + ASSUMPTIONS.generator.maintenancePct);
    assert.ok(Math.abs(r.generator.monthlyCost - r.usage.kwhPerMonth * perKwh) < r.usage.kwhPerMonth);
    assert.equal(r.generator.fuel, 'petrol');
  });

  it('costs more per month as the grid gives fewer hours (Band A cheapest, Band E dearest)', () => {
    const totals = r.grid.bands.map((b) => b.totalMonthly);
    assert.deepEqual(totals, [...totals].sort((a, b) => a - b));
    assert.equal(r.grid.bands.length, 5);
    assert.ok(r.grid.bands[0].totalMonthly < r.generator.monthlyCost);
  });

  it('uses the chosen band as the "what you pay today" baseline, or the generator when unsure', () => {
    assert.equal(r.current.kind, 'generator-only');
    const bandC = run({ ...base, supplyBand: 'C', items: family });
    assert.equal(bandC.current.band, 'C');
    assert.equal(bandC.current.monthlyCost, bandC.grid.bands.find((b) => b.band === 'C').totalMonthly);
  });

  it('sizes a bigger solar system and costs more for a bigger load', () => {
    const small = run({ ...base, items: catalogs.home.presets.find((p) => p.id === 'flat').items });
    assert.ok(r.solar.kwp > small.solar.kwp);
    assert.ok(r.solar.systemCost > small.solar.systemCost);
    assert.ok(r.solar.inverterKva >= small.solar.inverterKva);
  });

  it('computes lease, rent and energy-as-a-service from the system cost', () => {
    const F = ASSUMPTIONS.financing;
    const cost = r.solar.systemCost;
    const deposit = cost * F.lease.depositPct;
    const expectedLease = (cost * (1 + F.lease.markupPct) - deposit) / F.lease.termMonths;
    assert.ok(Math.abs(r.options.lease.monthly - expectedLease) <= 1);
    assert.equal(r.options.rent.monthly, Math.round(cost * F.rent.monthlyPct));
    assert.ok(['buy', 'lease', 'rent'].includes(r.options.lowestTotalKey));
  });

  it('offers energy as a service to businesses only, and never suggests it to homes', () => {
    const business = run({ ...base, segment: 'business', items: base.items ?? [] });
    assert.equal(business.options.eaas.upfront, 0);
    assert.ok(business.options.eaas.perKwh > 0);
    assert.equal(r.options.eaas, undefined); // a home assessment
    assert.notEqual(r.options.suggested, 'eaas');
    assert.notEqual(r.options.lowestTotalKey, 'eaas');
  });

  it('says so when solar will not save money, instead of pushing an option', () => {
    // Very cheap power: nothing Sunledger sells can beat it, so the result must say so.
    const cheapPower = {
      ...ASSUMPTIONS,
      fuelPricePerLitre: 1,
      tariffs: { default: { A: 5, B: 5, C: 5, D: 5, E: 5 } },
    };
    const cheap = run({ ...base, supplyBand: 'A', items: family }, cheapPower);
    assert.equal(cheap.flags.solarMayNotPayBack, true);
    assert.equal(cheap.options.suggested, null);
    assert.equal(cheap.solar.paybackMonthsVsCurrent, null);
  });

  it('recommends a site survey for very large business loads', () => {
    const big = run({
      segment: 'business', disco: 'aedc', supplyBand: 'C',
      items: [{ applianceId: 'b-central-ac', variantId: '40tr', qty: 2 }],
    });
    assert.equal(big.flags.needsSiteAudit, true);
    assert.equal(big.generator.fuel, 'diesel');
  });
});

describe('catalogues', () => {
  const entries = Object.entries(catalogs);

  it('has unique ids, exactly one default variant, and valid hour keys', () => {
    for (const [segment, c] of entries) {
      const ids = new Set();
      for (const ap of c.appliances) {
        assert.ok(!ids.has(ap.id), `${segment}: duplicate appliance ${ap.id}`);
        ids.add(ap.id);
        assert.ok(c.categories.includes(ap.category), `${ap.id}: unknown category ${ap.category}`);
        assert.equal(ap.variants.filter((x) => x.default).length, 1, `${ap.id}: needs exactly one default variant`);
        assert.equal(new Set(ap.variants.map((x) => x.id)).size, ap.variants.length, `${ap.id}: duplicate variant ids`);
        assert.ok(HOURS_BY_KEY.has(ap.defaultHours), `${ap.id}: bad defaultHours`);
        for (const x of ap.variants) assert.ok(x.watts > 0, `${ap.id}/${x.id}: watts must be positive`);
      }
    }
  });

  it('only offers presets that resolve to real items, and every preset calculates', () => {
    for (const [segment, c] of entries) {
      for (const preset of c.presets) {
        const out = run({ segment, disco: 'aedc', supplyBand: 'B', items: preset.items });
        assert.ok(out.usage.kwhPerDay > 0, `${preset.id} should use some energy`);
      }
    }
  });

  it('gives a bank branch a plausible daily use (tens to a couple of hundred kWh)', () => {
    const items = catalogs.business.presets.find((p) => p.id === 'branch').items;
    const out = run({ segment: 'business', disco: 'aedc', supplyBand: 'B', items });
    assert.ok(out.usage.kwhPerDay > 100 && out.usage.kwhPerDay < 600, `got ${out.usage.kwhPerDay}`);
  });
});
