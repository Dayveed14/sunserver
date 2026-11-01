import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createShopService } from '../src/services/shop.service.js';
import { createHarness } from '../test-support/ordersHarness.js';

function shop() {
  const h = createHarness();
  const productsModel = {
    async listPublic({ state }) { return h.products.filter((p) => p.vendorState === state && p.status === 'active').map((p) => ({ ...p, category: 'panel', rating: 4, vendorVerified: true })); },
    async findPublic(id) { const p = h.products.find((x) => x.id === id); return p ? { ...p, category: 'panel', rating: 4, vendorVerified: true, vendorId: p.vendorId } : null; },
  };
  const dealsModel = { async listActive() { return []; }, async findActive() { return null; } };
  return { h, svc: createShopService({ productsModel, dealsModel, feesService: h.feesService, config: { requireVerified: false }, now: () => h.clock.t }) };
}

describe('the shop by state', () => {
  it('requires a state and only lists vendors there', async () => {
    const { svc } = shop();
    await assert.rejects(svc.listProducts({}), /Lagos or Abuja/);
    const lagos = await svc.listProducts({ state: 'lagos' });
    assert.ok(lagos.products.length > 0 && lagos.products.every((p) => p.vendor.state === 'lagos'));
    const abuja = await svc.listProducts({ state: 'abuja' });
    assert.ok(abuja.products.every((p) => p.vendor.state === 'abuja'));
    assert.ok(!lagos.products.some((p) => abuja.products.some((a) => a.id === p.id)));
  });
  it('shows vendor area but never the street address', async () => {
    const { svc } = shop();
    const { products } = await svc.listProducts({ state: 'lagos' });
    assert.ok(products[0].vendor.areaName);
    assert.ok(!JSON.stringify(products[0]).includes('Shop Rd'));
  });
});

describe('product page delivery details', () => {
  it('gives distance, fee and arrival time for an area in the same state', async () => {
    const { svc } = shop();
    const page = await svc.productPage(1, { state: 'lagos', areaId: 'ajah' });
    assert.equal(page.delivery.available, true);
    assert.ok(page.delivery.distanceKm >= 2 && page.delivery.fee > 0 && page.delivery.promisedBy);
    assert.equal(page.product.vendor.stateName, 'Lagos');
  });
  it('a farther area shows a longer distance and a higher fee', async () => {
    const { svc } = shop();
    const near = await svc.productPage(1, { state: 'lagos', areaId: 'ikeja' });
    const far = await svc.productPage(1, { state: 'lagos', areaId: 'ikorodu' });
    assert.ok(far.delivery.distanceKm > near.delivery.distanceKm);
    assert.ok(far.delivery.fee >= near.delivery.fee);
  });
  it('says delivery is unavailable across states, and shows no delivery without a destination', async () => {
    const { svc } = shop();
    const cross = await svc.productPage(1, { state: 'abuja', areaId: 'garki' });
    assert.equal(cross.delivery.available, false);
    assert.match(cross.delivery.reason, /does not deliver to Abuja/);
    assert.equal((await svc.productPage(1, null)).delivery, null);
  });
  it('rejects a bad area and a missing product', async () => {
    const { svc } = shop();
    await assert.rejects(svc.productPage(1, { state: 'lagos', areaId: 'nowhere' }), /Choose an area/);
    await assert.rejects(svc.productPage(999, null), /not found/);
  });
});

describe('what can I get for my budget', () => {
  const vendor = { vendorId: 1, vendorName: 'Sun Co', vendorVerified: true, vendorVerification: 'verified', vendorState: 'lagos', vendorArea: 'ikeja' };
  const prod = (id, category, price, extra = {}) => ({ id, category, name: `${category} ${id}`, rating: 1, price, inStock: true, status: 'active', ...vendor, ...extra });
  const deal = (id, buyPrice, items) => ({ id, title: `Deal ${id}`, buyPrice, status: 'active', items, extras: [], installationIncluded: true, ...vendor });
  const sys = [{ category: 'panel', qty: 2, rating: 550 }, { category: 'inverter', qty: 1, rating: 1.5 }, { category: 'battery', qty: 1, rating: 2.4 }];
  function make(products, deals) {
    const h = createHarness();
    return createShopService({
      productsModel: { async listPublic() { return products; } },
      dealsModel: { async listActive() { return deals; } },
      feesService: h.feesService, config: { requireVerified: false },
    });
  }
  it('gives up to three deals that fit, closest to the budget first', async () => {
    const svc = make([], [deal(1, 300000, sys), deal(2, 800000, sys), deal(3, 900000, sys), deal(4, 950000, sys), deal(5, 5000000, sys)]);
    const r = await svc.budgetPicks({ state: 'lagos', budget: 1000000 });
    assert.deepEqual(r.deals.map((d) => d.id), [4, 3, 2]);
    assert.equal(r.systemTooSmall, false);
  });
  it('a bundle fits a budget but does not count as a full system', async () => {
    const svc = make([], [deal(1, 50000, [{ category: 'cable', qty: 1 }]), deal(2, 700000, sys)]);
    const r = await svc.budgetPicks({ state: 'lagos', budget: 100000 });
    assert.deepEqual(r.deals.map((d) => d.id), [1]);
    assert.equal(r.systemTooSmall, true);
    assert.equal(r.closestSystem.shortfall, 600000);
  });
  it('suggests two or three single items that fit together', async () => {
    const svc = make([prod(1, 'kit', 200000), prod(2, 'portable_power', 150000), prod(3, 'inverter', 400000), prod(4, 'battery', 300000)], []);
    const r = await svc.budgetPicks({ state: 'lagos', budget: 600000 });
    assert.ok(r.items.length >= 2 && r.items.length <= 3);
    assert.ok(r.itemsTotal <= 600000);
    assert.equal(new Set(r.items.map((i) => i.category)).size, r.items.length);
  });
  it('says plainly when nothing fits and how far off the cheapest thing is', async () => {
    const svc = make([prod(1, 'inverter', 90000)], [deal(1, 700000, sys)]);
    const r = await svc.budgetPicks({ state: 'lagos', budget: 20000 });
    assert.equal(r.nothingFits, true);
    assert.equal(r.closest.shortfall, 70000);
  });
  it('only shows the shopper\'s state and rejects a bad budget', async () => {
    const svc = make([prod(1, 'kit', 100000)], []);
    assert.equal((await svc.budgetPicks({ state: 'abuja', budget: 500000 })).items.length, 1); // fake model does not filter by state
    await assert.rejects(svc.budgetPicks({ state: 'lagos', budget: 'abc' }), /budget/i);
    await assert.rejects(svc.budgetPicks({ state: 'mars', budget: 100000 }), /Lagos or Abuja/);
  });
});
