import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  checkDealComposition, dealFit, dealSpecs, diyOptions, limits, matchDeals, planOffer,
  qtyRange, quoteDiy, requirementFromResult, seriesCount, voltageForKva,
} from '../src/modules/marketplace/matching.js';
import { createCatalogService } from '../src/modules/marketplace/catalog.service.js';
import { createOffersService } from '../src/modules/marketplace/offers.service.js';
import { dealSchema, productSchema } from '../src/modules/marketplace/marketplace.schemas.js';
import { createMarketplaceRepos } from '../test-support/marketplaceRepos.js';

// A small customer: 0.75 kWp of panels, a 1.5 kVA inverter, 2.5 kWh of battery.
const req = { panelKwp: 0.75, inverterKva: 1.5, batteryKwh: 2.5, suggestedVoltage: 12 };
const baseline = { monthlyCost: 100000, monthlyMaintenance: 2000 };

const P = (id, category, rating, extra = {}) => ({
  id, vendorId: 1, vendorName: 'Sun Co', category, name: `${category} ${rating}`, brand: null, rating,
  systemVoltage: category === 'panel' ? null : 12, price: 100000, inStock: true, status: 'active', ...extra,
});

describe('sizing helpers', () => {
  it('picks a sensible system voltage from inverter size', () => {
    assert.equal(voltageForKva(1.5), 12);
    assert.equal(voltageForKva(2), 24);
    assert.equal(voltageForKva(3.5), 24);
    assert.equal(voltageForKva(5), 48);
  });

  it('reads the requirement from an assessment result', () => {
    const r = requirementFromResult({ solar: { kwp: 7.7, inverterKva: 7.5, batteryKwh: 21.5 } });
    assert.deepEqual(r, { panelKwp: 7.7, inverterKva: 7.5, batteryKwh: 21.5, suggestedVoltage: 48 });
  });

  it('works out how many batteries make one string', () => {
    assert.equal(seriesCount(24, 12), 2);
    assert.equal(seriesCount(48, 12), 4);
    assert.equal(seriesCount(12, 24), null);
    assert.equal(seriesCount(24, null), null);
  });

  it('describes the allowed range for the screen', () => {
    const l = limits(req);
    assert.equal(l.inverter.minKva, 1.5);
    assert.equal(l.inverter.maxKva, 2.25);
    assert.equal(l.panel.maxKwp, 1.2);
  });
});

describe('quantity ranges', () => {
  it('lets a 750W panel through as exactly one, and rounds smaller panels up', () => {
    assert.deepEqual(qtyRange('panel', { rating: 750 }, req), { min: 1, max: 1, step: 1 });
    assert.deepEqual(qtyRange('panel', { rating: 500 }, req), { min: 2, max: 2, step: 1 });
    assert.deepEqual(qtyRange('panel', { rating: 400 }, req), { min: 2, max: 3, step: 1 });
  });

  it('rejects a panel far too big for the need', () => {
    assert.equal(qtyRange('panel', { rating: 3000 }, req), null);
  });

  it('only accepts inverters from the minimum up to 1.5x', () => {
    assert.ok(qtyRange('inverter', { rating: 1.5 }, req));
    assert.ok(qtyRange('inverter', { rating: 2 }, req));
    assert.equal(qtyRange('inverter', { rating: 1 }, req), null);
    assert.equal(qtyRange('inverter', { rating: 3 }, req), null);
  });

  it('pairs batteries for higher voltage inverters', () => {
    const b = { rating: 1.2, systemVoltage: 12 };
    const on12 = qtyRange('battery', b, req, { inverterVoltage: 12 });
    const on24 = qtyRange('battery', b, req, { inverterVoltage: 24 });
    assert.equal(on12.step, 1);
    assert.equal(on24.step, 2);
    assert.equal(on24.min % 2, 0);
    assert.ok(on24.min * 1.2 >= 2.5 * 0.95);
    assert.equal(qtyRange('battery', { rating: 1.2, systemVoltage: 24 }, req, { inverterVoltage: 12 }), null);
  });

  it('asks for no battery when the customer has no night load', () => {
    assert.equal(qtyRange('battery', { rating: 2.4, systemVoltage: 12 }, { ...req, batteryKwh: 0 }), null);
  });
});

describe('DIY options', () => {
  it('lists only products in range and in stock', () => {
    const opts = diyOptions(req, [
      P(1, 'panel', 750), P(2, 'panel', 500), P(3, 'panel', 5000), P(4, 'panel', 550, { inStock: false }),
      P(5, 'inverter', 1.5), P(6, 'inverter', 2), P(7, 'inverter', 5),
      P(8, 'battery', 2.4), P(9, 'battery', 100),
    ]);
    assert.deepEqual(opts.panels.map((o) => o.product.id).sort(), [1, 2]);
    assert.deepEqual(opts.inverters.map((o) => o.product.id).sort(), [5, 6]);
    assert.deepEqual(opts.batteries.map((o) => o.product.id), [8]);
  });
});

describe('DIY quote', () => {
  const catalog = new Map([
    P(1, 'panel', 750), P(5, 'inverter', 1.5), P(6, 'inverter', 2, { systemVoltage: 24 }),
    P(8, 'battery', 2.4), P(9, 'battery', 1.2), P(10, 'battery', 2.4, { vendorId: 2, vendorName: 'Other Co' }),
  ].map((p) => [p.id, p]));
  const pick = (...pairs) => pairs.map(([productId, qty]) => ({ productId, qty }));
  const codes = (q) => q.errors.map((e) => e.code);

  it('prices a valid selection and totals the system', () => {
    const q = quoteDiy(req, pick([1, 1], [5, 1], [8, 1]), catalog);
    assert.equal(q.valid, true);
    assert.equal(q.subtotal, 300000);
    assert.deepEqual(q.totals, { kwp: 0.75, kva: 1.5, kwh: 2.4 });
  });

  it('requires one of each part', () => {
    assert.deepEqual(codes(quoteDiy(req, pick([1, 1], [5, 1]), catalog)), ['MISSING_BATTERY']);
    assert.deepEqual(codes(quoteDiy(req, pick([5, 1], [8, 1]), catalog)), ['MISSING_PANEL']);
  });

  it('only accepts batteries that match the inverter voltage, in complete strings', () => {
    // 24V inverter with 12V batteries: they must be wired in pairs
    assert.ok(codes(quoteDiy(req, pick([1, 1], [6, 1], [9, 1]), catalog)).includes('BATTERY_QTY'));
    assert.equal(quoteDiy(req, pick([1, 1], [6, 1], [9, 2]), catalog).valid, true);
    // 12V inverter with a 12V battery is fine; a 2.4 kWh 12V pair would overshoot the range
    assert.equal(quoteDiy(req, pick([1, 1], [5, 1], [8, 1]), catalog).valid, true);
    assert.ok(codes(quoteDiy(req, pick([1, 1], [6, 1], [8, 1]), catalog)).includes('BATTERY_OUT_OF_RANGE'));
  });

  it('rejects quantities outside the range and removed products', () => {
    assert.ok(codes(quoteDiy(req, pick([1, 3], [5, 1], [8, 1]), catalog)).includes('PANEL_QTY'));
    assert.ok(codes(quoteDiy(req, pick([1, 1], [5, 2], [8, 1]), catalog)).includes('INVERTER_OUT_OF_RANGE'));
    assert.ok(codes(quoteDiy(req, pick([1, 1], [5, 1], [999, 1]), catalog)).includes('PRODUCT_UNAVAILABLE'));
  });

  it('rejects two models of the same part', () => {
    assert.ok(codes(quoteDiy(req, pick([1, 1], [5, 1], [8, 1], [10, 1]), catalog)).includes('TOO_MANY'));
  });
});

describe('deals', () => {
  const item = (category, rating, qty, systemVoltage = 12) => ({ category, rating, qty, systemVoltage, name: category, productStatus: 'active' });
  const items = [item('panel', 550, 2, null), item('inverter', 1.5, 1), item('battery', 2.4, 1)];
  const deal = (over = {}) => ({
    id: 1, status: 'active', items, buyPrice: 900000,
    leaseDeposit: 100000, leaseMonthly: 30000, leaseMonths: 36,
    rentMonthly: 40000, eaasMonthly: 50000, eaasMonths: 60, ...over,
  });

  it('adds up the system size from its items', () => {
    assert.deepEqual(dealSpecs(items), { panelKwp: 1.1, inverterKva: 1.5, batteryKwh: 2.4, inverterVoltage: 12 });
  });

  it('checks that a deal is a working system', () => {
    assert.deepEqual(checkDealComposition(items), []);
    assert.equal(checkDealComposition(items.slice(0, 2))[0].code, 'MISSING_BATTERY');
    const mismatch = [item('panel', 550, 2, null), item('inverter', 3, 1, 24), item('battery', 2.4, 1, 12)];
    assert.ok(checkDealComposition(mismatch).some((e) => e.code === 'BATTERY_STRINGS'));
    const wrong = [item('panel', 550, 2, null), item('inverter', 1.5, 1, 12), item('battery', 2.4, 1, 24)];
    assert.ok(checkDealComposition(wrong).some((e) => e.code === 'VOLTAGE_MISMATCH'));
  });

  it('prices each plan and shows the saving against today', () => {
    assert.equal(planOffer(deal(), 'buy', baseline).upfront, 900000);
    assert.equal(planOffer(deal(), 'buy', baseline).paybackMonths, Math.ceil(900000 / 98000));
    const lease = planOffer(deal(), 'lease', baseline);
    assert.equal(lease.totalCost, 100000 + 30000 * 36);
    assert.equal(lease.monthlySaving, 70000);
    assert.equal(planOffer(deal(), 'eaas', baseline).upfront, 0);
    assert.equal(planOffer(deal({ rentMonthly: null }), 'rent', baseline), null);
  });

  it('only matches deals that cover the need without being oversized', () => {
    assert.ok(dealFit(req, dealSpecs(items)));
    const small = dealSpecs([item('panel', 550, 1, null), item('inverter', 1.5, 1), item('battery', 2.4, 1)]);
    assert.equal(dealFit(req, small), null); // 0.55 kWp is under the minimum
    const huge = dealSpecs([item('panel', 550, 20, null), item('inverter', 5, 1, 48), item('battery', 10, 1, 48)]);
    assert.equal(dealFit(req, huge), null);
  });

  it('ranks matches cheapest first, and skips drafts and removed products', () => {
    const cheap = deal({ id: 2, buyPrice: 700000 });
    const draft = deal({ id: 3, status: 'draft', buyPrice: 100000 });
    const broken = deal({ id: 4, buyPrice: 50000, items: [{ ...items[0], productStatus: 'archived' }, items[1], items[2]] });
    const noBuy = deal({ id: 5, buyPrice: null });
    const out = matchDeals(req, [deal(), cheap, draft, broken, noBuy], 'buy', baseline);
    assert.deepEqual(out.map((m) => m.deal.id), [2, 1]);
  });
});

describe('product and deal validation', () => {
  const ok = { category: 'panel', name: 'Longi 550W', rating: 550, price: 95000 };

  it('accepts sensible products and normalises them', () => {
    const p = productSchema.parse({ ...ok, systemVoltage: 24, brand: '' });
    assert.equal(p.systemVoltage, null); // panels have no system voltage
    assert.equal(p.brand, null);
  });

  it('checks sizes in the right unit for each category', () => {
    assert.equal(productSchema.safeParse({ ...ok, rating: 5 }).success, false);
    assert.equal(productSchema.safeParse({ category: 'inverter', name: 'Inv', rating: 1.5, price: 150000 }).success, false); // voltage missing
    assert.equal(productSchema.safeParse({ category: 'inverter', name: 'Inv', rating: 1.5, price: 150000, systemVoltage: 12 }).success, true);
    assert.equal(productSchema.safeParse({ category: 'battery', name: 'Bat', rating: 300, price: 150000, systemVoltage: 12 }).success, false);
  });

  it('needs at least one price on a deal', () => {
    const base = { title: 'Starter', items: [{ productId: 1, qty: 2 }, { productId: 2, qty: 1 }, { productId: 3, qty: 1 }] };
    assert.equal(dealSchema.safeParse(base).success, false);
    const parsed = dealSchema.parse({ ...base, rentMonthly: 40000 });
    assert.equal(parsed.rentMonthly, 40000);
    assert.equal(parsed.buyPrice, null);
  });
});

describe('vendor catalogue rules', () => {
  let repos, svc;
  beforeEach(() => {
    repos = createMarketplaceRepos();
    svc = createCatalogService(repos);
  });
  const prod = (category, rating, voltage) => ({ category, name: `${category} ${rating}`, rating, systemVoltage: voltage ?? null, price: 100000, inStock: true, status: 'active' });
  const dealData = (items) => ({ title: 'Starter', description: null, items, installationIncluded: true, warrantyYears: null, buyPrice: 900000, leaseDeposit: null, leaseMonthly: null, leaseMonths: null, rentMonthly: null, eaasMonthly: null, eaasMonths: null, status: 'active' });

  it('builds a deal only from the vendor\'s own products', async () => {
    const a = await svc.createProduct(1, prod('panel', 550));
    const b = await svc.createProduct(1, prod('inverter', 1.5, 12));
    const c = await svc.createProduct(1, prod('battery', 2.4, 12));
    const theirs = await svc.createProduct(2, prod('battery', 2.4, 12));

    const deal = await svc.createDeal(1, dealData([{ productId: a.id, qty: 2 }, { productId: b.id, qty: 1 }, { productId: c.id, qty: 1 }]));
    assert.equal(deal.specs.panelKwp, 1.1);
    assert.deepEqual(deal.plans, ['buy']);

    await assert.rejects(
      svc.createDeal(1, dealData([{ productId: a.id, qty: 2 }, { productId: b.id, qty: 1 }, { productId: theirs.id, qty: 1 }])),
      (e) => e.code === 'INVALID_DEAL'
    );
  });

  it('will not let a vendor edit or remove someone else\'s product', async () => {
    const p = await svc.createProduct(1, prod('panel', 550));
    await assert.rejects(svc.updateProduct(2, p.id, prod('panel', 400)), (e) => e.status === 404);
    await assert.rejects(svc.archiveProduct(2, p.id), (e) => e.status === 404);
  });

  it('will not change a product\'s type', async () => {
    const p = await svc.createProduct(1, prod('panel', 550));
    await assert.rejects(svc.updateProduct(1, p.id, prod('battery', 2.4, 12)), (e) => e.code === 'VALIDATION_ERROR');
  });

  it('blocks publishing a deal that uses a removed product', async () => {
    const a = await svc.createProduct(1, prod('panel', 550));
    const b = await svc.createProduct(1, prod('inverter', 1.5, 12));
    const c = await svc.createProduct(1, prod('battery', 2.4, 12));
    const deal = await svc.createDeal(1, { ...dealData([{ productId: a.id, qty: 2 }, { productId: b.id, qty: 1 }, { productId: c.id, qty: 1 }]), status: 'draft' });
    await svc.archiveProduct(1, a.id);
    // the deal view still lists the archived product so the vendor can see what to fix
    await assert.rejects(svc.setDealStatus(1, deal.id, 'active'), (e) => e.code === 'INVALID_DEAL');
  });
});

describe('customer offers and requests', () => {
  let repos, svc;
  const result = {
    segment: 'home', supplyBand: 'B', disco: { id: 'aedc', name: 'AEDC' },
    usage: { kwhPerDay: 3, connectedKw: 1.2 },
    solar: { kwp: 0.75, inverterKva: 1.5, batteryKwh: 2.5, monthlyMaintenance: 2000 },
    current: { monthlyCost: 100000 },
    options: { buy: { key: 'buy' }, lease: { key: 'lease' }, rent: { key: 'rent' }, eaas: { key: 'eaas' } },
  };

  beforeEach(() => {
    repos = createMarketplaceRepos();
    repos.setVendor(1, 'Sun Co', 'verified');
    repos.setVendor(2, 'Volt Ltd', 'pending');
    repos.setVendor(3, 'Bad Co', 'rejected');
    repos.addAssessment(10, 7, result);
    svc = createOffersService({ ...repos, config: { requireVerified: false } });
  });

  const seedParts = async () => {
    const mk = (vendorId, category, rating, voltage) =>
      repos.productsRepo.create(vendorId, { category, name: `${category} ${rating}`, rating, systemVoltage: voltage ?? null, price: 100000, inStock: true, status: 'active' });
    return {
      panel: await mk(1, 'panel', 750),
      inverter: await mk(1, 'inverter', 1.5, 12),
      battery: await mk(2, 'battery', 2.4, 12),
      hidden: await mk(3, 'battery', 2.4, 12),
    };
  };
  const seedDeal = async (vendorId = 1, buyPrice = 800000) => {
    const mk = (category, rating, voltage) => repos.productsRepo.create(vendorId, { category, name: category, rating, systemVoltage: voltage ?? null, price: 1, inStock: true, status: 'active' });
    const items = [{ productId: await mk('panel', 550), qty: 2 }, { productId: await mk('inverter', 1.5, 12), qty: 1 }, { productId: await mk('battery', 2.4, 12), qty: 1 }];
    return repos.dealsRepo.create(vendorId, { title: 'Deal', items, status: 'active', buyPrice, leaseDeposit: null, leaseMonthly: 30000, leaseMonths: 24, rentMonthly: null, eaasMonthly: null, eaasMonths: null });
  };

  it('shows only the owner their own assessment', async () => {
    await assert.rejects(svc.getOffers(99, 10, 'buy', 'individual'), (e) => e.status === 404);
  });

  it('returns deals for the plan and DIY options for buying, hiding rejected vendors', async () => {
    const parts = await seedParts();
    await seedDeal();
    const buy = await svc.getOffers(7, 10, 'buy', 'individual');
    assert.equal(buy.deals.length, 1);
    assert.deepEqual(buy.dealCounts, { buy: 1, lease: 1, rent: 0 }); // no energy as a service for individuals
    assert.equal(buy.diy.panels.length, 2); // the 750W panel and the deal's 550W panel
    assert.equal(buy.diy.batteries.length, 2); // vendor 2's battery and the deal's; the rejected vendor's is hidden
    assert.ok(!buy.diy.batteries.some((b) => b.id === parts.hidden));
    const lease = await svc.getOffers(7, 10, 'lease', 'individual');
    assert.equal(lease.diy, undefined);
    assert.equal(lease.deals[0].offer.monthlySaving, 70000);
    await assert.rejects(svc.getOffers(7, 10, 'swap', 'individual'), (e) => e.code === 'VALIDATION_ERROR');
    await assert.rejects(svc.getOffers(7, 10, 'eaas', 'individual'), (e) => e.code === 'NOT_AVAILABLE');
    assert.ok((await svc.getOffers(7, 10, 'buy', 'business')).dealCounts.eaas !== undefined); // businesses still see it
  });

  it('splits a DIY order into one request per vendor', async () => {
    const p = await seedParts();
    const out = await svc.createRequests(7, 10, { kind: 'diy', items: [{ productId: p.panel, qty: 1 }, { productId: p.inverter, qty: 1 }, { productId: p.battery, qty: 1 }] });
    assert.equal(out.requests.length, 2);
    const sun = repos.requests.find((r) => r.vendorId === 1);
    assert.equal(sun.upfrontPrice, 200000);
    assert.deepEqual(sun.summary.wholeSystem.otherVendors, ['Volt Ltd']);
  });

  it('refuses an invalid DIY selection and a repeat request', async () => {
    const p = await seedParts();
    await assert.rejects(
      svc.createRequests(7, 10, { kind: 'diy', items: [{ productId: p.panel, qty: 5 }, { productId: p.inverter, qty: 1 }, { productId: p.battery, qty: 1 }] }),
      (e) => e.code === 'INVALID_SELECTION'
    );
    const items = [{ productId: p.panel, qty: 1 }, { productId: p.inverter, qty: 1 }, { productId: p.battery, qty: 1 }];
    await svc.createRequests(7, 10, { kind: 'diy', items });
    await assert.rejects(svc.createRequests(7, 10, { kind: 'diy', items }), (e) => e.code === 'ALREADY_REQUESTED');
  });

  it('records a deal request with a price snapshot, once', async () => {
    const dealId = await seedDeal();
    const out = await svc.createRequests(7, 10, { kind: 'deal', dealId, plan: 'lease' });
    assert.equal(out.requests.length, 1);
    const saved = repos.requests[0];
    assert.equal(saved.monthlyPrice, 30000);
    assert.equal(saved.summary.offer.termMonths, 24);
    await assert.rejects(svc.createRequests(7, 10, { kind: 'deal', dealId, plan: 'lease' }), (e) => e.code === 'ALREADY_REQUESTED');
    await assert.rejects(svc.createRequests(7, 10, { kind: 'deal', dealId, plan: 'rent' }), (e) => e.code === 'NOT_A_MATCH');
  });

  it('lets a customer cancel only their own open request', async () => {
    const dealId = await seedDeal();
    const { requests } = await svc.createRequests(7, 10, { kind: 'deal', dealId, plan: 'buy' });
    await assert.rejects(svc.cancel(99, requests[0].id), (e) => e.status === 404);
    await svc.cancel(7, requests[0].id);
    assert.equal(repos.requests[0].status, 'cancelled');
  });
});
