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
