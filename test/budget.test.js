import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allInOneOptions, cheapestSystem, evaluateBudget } from '../src/utils/budget.js';
import { neededExtras, quoteDiy, requirementFromResult } from '../src/utils/matching.js';

const req = { panelKwp: 2.2, inverterKva: 3, batteryKwh: 5, suggestedVoltage: 24 };
let n = 0;
const p = (category, rating, price, extra = {}) => ({
  id: ++n, vendorId: 1, vendorName: 'Vendor', category, name: `${category} ${n}`, rating, price, inStock: true, status: 'active',
  systemVoltage: category === 'inverter' || category === 'battery' ? 24 : null, includesController: true, ...extra,
});

const products = [
  p('panel', 550, 100000), p('panel', 400, 70000),
  p('inverter', 3, 350000), p('inverter', 4, 600000, { includesController: false }),
  p('battery', 2.4, 300000, { systemVoltage: 12 }),
  p('mounting', 0, 40000), p('cable', 0, 25000), p('connector', 0, 8000), p('protection', 0, 12000),
];

describe('which extras a system needs', () => {
  it('asks for a charge controller only when the inverter has none built in', () => {
    assert.ok(!neededExtras({ includesController: true }).includes('controller'));
    assert.ok(neededExtras({ includesController: false }).includes('controller'));
    assert.ok(!neededExtras(null).includes('controller'));
  });
});

describe('cheapest complete system', () => {
  it('adds the cheapest listed extras and an allowance for parts nobody lists yet', () => {
    const s = cheapestSystem(req, products);
    assert.ok(s);
    assert.equal(s.lines.map((l) => l.category).join(), 'panel,inverter,battery');
    assert.deepEqual(s.extras.map((e) => e.category).sort(), ['cable', 'connector', 'mounting', 'protection']);
    assert.deepEqual(s.missingExtras.sort(), ['distribution', 'earthing', 'surge_protection']);
    assert.ok(s.estimatedExtras > 0, 'missing parts are not treated as free');
    assert.equal(s.total, s.coreTotal + s.extrasTotal + s.estimatedExtras);
  });

  it('is null when a core part is missing', () => {
    assert.equal(cheapestSystem(req, products.filter((x) => x.category !== 'battery')), null);
  });
});

describe('all-in-one units', () => {
  it('separates full cover from partial cover', () => {
    const list = [p('kit', 2.4, 1500000), p('kit', 0.6, 250000), p('portable_power', 5.2, 900000), p('portable_power', 1.0, 200000)];
    const aio = allInOneOptions(req, list);
    assert.deepEqual(aio.kits.map((k) => k.fit), ['partial', 'full']);
    assert.equal(aio.portable.find((k) => k.product.price === 200000).fit, 'partial');
    assert.equal(aio.portable.find((k) => k.product.price === 900000).fit, 'full');
  });
});

describe('budget check', () => {
  const system = cheapestSystem(req, products);
  const base = { plan: 'buy', deals: [], system, allInOne: { kits: [], portable: [] }, otherPlans: [], result: { usage: { topConsumers: [{ name: 'Air conditioner', sharePct: 45 }, { name: 'Freezer', sharePct: 20 }] } } };

  it('says nothing is wrong when no budget was given', () => {
    assert.equal(evaluateBudget({ ...base, budget: null }).status, 'no_budget');
  });
  it('is fine when the cheapest option fits', () => {
    const r = evaluateBudget({ ...base, budget: system.total + 1 });
    assert.equal(r.status, 'ok');
    assert.equal(r.shortfall, 0);
  });
  it('is too small below the cheapest option, with the shortfall, a way to cut load and cheaper ways to pay', () => {
    const aio = allInOneOptions(req, [p('portable_power', 1.0, 200000)]);
    const r = evaluateBudget({
      ...base, budget: 300000, allInOne: aio,
      otherPlans: [{ plan: 'rent', upfront: 120000, monthly: 120000, dealTitle: 'Rent a starter set' }, { plan: 'lease', upfront: 900000, monthly: 50000, dealTitle: 'Too dear upfront' }],
    });
    assert.equal(r.status, 'too_small');
    assert.equal(r.shortfall, system.total - 300000);
    assert.equal(r.cheapest.price, system.total);
    assert.ok(r.reduceLoad.cutPct >= 5 && r.reduceLoad.biggest[0].name === 'Air conditioner');
    assert.deepEqual(r.alternatives.map((a) => a.type + ':' + (a.plan ?? a.category)), ['partial:portable_power', 'plan:rent']);
  });
  it('says nothing is available when there is no way to meet the need', () => {
    const r = evaluateBudget({ ...base, budget: 5000000, system: null });
    assert.equal(r.status, 'nothing_available');
  });
  it('counts a full-cover kit as an option', () => {
    const aio = allInOneOptions(req, [p('kit', 2.4, 1200000)]);
    const r = evaluateBudget({ ...base, budget: 5000000, allInOne: aio });
    assert.equal(r.cheapest.price, Math.min(system.total, 1200000));
  });
});

describe('custom system with extras', () => {
  const byId = new Map(products.map((x) => [x.id, x]));
  const pick = (cat) => products.find((x) => x.category === cat);
  const core = [
    { productId: products[0].id, qty: 4 },
    { productId: products[2].id, qty: 1 },
    { productId: products[4].id, qty: 2 },
  ];
  it('prices extras into the total and says which parts are still missing', () => {
    const q = quoteDiy(req, [...core, { productId: pick('cable').id, qty: 3 }], byId);
    assert.equal(q.valid, true, JSON.stringify(q.errors));
    assert.equal(q.subtotal, 4 * 100000 + 350000 + 2 * 300000 + 3 * 25000);
    assert.ok(q.extrasMissing.includes('mounting') && !q.extrasMissing.includes('cable'));
  });
  it('refuses a product that is not part of a system, instead of crashing', () => {
    const odd = p('pump', 500, 90000);
    byId.set(odd.id, odd);
    const q = quoteDiy(req, [...core, { productId: odd.id, qty: 1 }], byId);
    assert.equal(q.valid, false);
    assert.ok(q.errors.some((e) => e.code === 'NOT_PART_OF_SYSTEM'));
  });
});

describe('requirement helper still works', () => {
  it('reads the assessment', () => {
    assert.equal(requirementFromResult({ solar: { kwp: 2.2, inverterKva: 3, batteryKwh: 5 } }).suggestedVoltage, 24);
  });
});
