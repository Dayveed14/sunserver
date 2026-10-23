import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createCatalogService } from '../src/services/catalog.service.js';
import { createShopService } from '../src/services/shop.service.js';
import { CATEGORY_SPECS, CORE_CATEGORIES, PRODUCT_CATEGORIES } from '../src/utils/productCategories.js';
import { productSchema } from '../src/validators/marketplace.schemas.js';
import { createHarness } from '../test-support/ordersHarness.js';
import { createMarketplaceModels } from '../test-support/marketplaceModels.js';

const base = { name: 'Thing', price: 5000, inStock: true, status: 'active' };
const parse = (o) => productSchema.safeParse({ ...base, ...o });
const failsWith = (p) => p.then(() => null, (e) => e);

describe('the list of product types', () => {
  it('has the 22 types in the same order as the database list, panel, inverter, battery first', () => {
    assert.equal(PRODUCT_CATEGORIES.length, 22);
    assert.deepEqual(PRODUCT_CATEGORIES.slice(0, 3), ['panel', 'inverter', 'battery']);
    assert.deepEqual(Object.keys(CATEGORY_SPECS).sort(), [...PRODUCT_CATEGORIES].sort());
    assert.deepEqual(CORE_CATEGORIES, ['panel', 'inverter', 'battery']);
  });
  it('matches the SQL file you run by hand', async () => {
    const fs = await import('node:fs');
    const sql = fs.readFileSync(new URL('../sql/manual/add-product-categories.sql', import.meta.url), 'utf8');
    const listed = [...sql.matchAll(/^\s+'([a-z_]+)',?$/gm)].map((m) => m[1]);
    assert.deepEqual(listed, PRODUCT_CATEGORIES);
  });
});

describe('product checks for the new types', () => {
  it('still checks panels, inverters and batteries as before', () => {
    assert.equal(parse({ category: 'panel', rating: 550 }).success, true);
    assert.equal(parse({ category: 'panel', rating: 20 }).success, false);
    assert.equal(parse({ category: 'inverter', rating: 5, systemVoltage: 48, price: 400000 }).success, true);
    assert.equal(parse({ category: 'inverter', rating: 5, price: 400000 }).success, false);
    assert.equal(parse({ category: 'battery', rating: 2.4, systemVoltage: 12, price: 5000 }).success, true);
    assert.equal(parse({ category: 'battery', rating: 2.4, systemVoltage: 12, price: 500 }).success, false); // core price looks too low
  });
  it('a charge controller needs an amp rating; the voltage is optional', () => {
    assert.equal(parse({ category: 'controller', rating: 60 }).success, true);
    assert.equal(parse({ category: 'controller', rating: 60, systemVoltage: 48 }).data.systemVoltage, 48);
    assert.equal(parse({ category: 'controller' }).success, false);
    assert.equal(parse({ category: 'controller', rating: 60.5 }).success, false);
    assert.equal(parse({ category: 'controller', rating: 60, systemVoltage: 36 }).success, false);
  });
  it('a portable power station is sized in kWh (the bug where the key was "portablePower" is gone)', () => {
    const ok = parse({ category: 'portable_power', rating: 1.2, systemVoltage: 24 });
    assert.equal(ok.success, true);
    assert.equal(parse({ category: 'portablePower', rating: 1.2 }).success, false);
  });
  it('things with no size (cables, mounting ...) need no number and store 0', () => {
    for (const category of ['cable', 'mounting', 'connector', 'earthing', 'surge_protection', 'distribution', 'meter', 'monitoring', 'accessory', 'energy_management']) {
      const r = parse({ category, price: 200, systemVoltage: 24, batteryType: 'gel' });
      assert.equal(r.success, true, category);
      assert.equal(r.data.rating, 0);
      assert.equal(r.data.systemVoltage, null);
      assert.equal(r.data.batteryType, null);
    }
  });
  it('sized-or-not types: breakers and transfer switches may leave the amps empty; pumps, lights and kits need a size', () => {
    assert.equal(parse({ category: 'protection' }).data.rating, 0);
    assert.equal(parse({ category: 'transfer_switch', rating: 63 }).data.rating, 63);
    for (const category of ['pump', 'streetlight', 'lighting', 'generator', 'kit']) assert.equal(parse({ category }).success, false, category);
    assert.equal(parse({ category: 'kit', rating: 1.5, price: 900000 }).success, true);
    assert.equal(parse({ category: 'streetlight', rating: 60 }).success, true);
  });
  it('an unknown type is refused', () => {
    assert.equal(parse({ category: 'spaceship', rating: 1 }).success, false);
  });
});

describe('the shop and the new types', () => {
  function shop() {
    const h = createHarness();
    const seen = [];
    const productsModel = {
      async listPublic(args) { seen.push(args); return []; },
      async findPublic() { return null; },
    };
    return { seen, svc: createShopService({ productsModel, dealsModel: { async listActive() { return []; } }, feesService: h.feesService, config: { requireVerified: false } }) };
  }
  it('accepts every real type, and "more" means everything except panel, inverter, battery', async () => {
    const { svc, seen } = shop();
    for (const category of PRODUCT_CATEGORIES) await svc.listProducts({ state: 'lagos', category });
    assert.equal(seen.at(-1).category, 'kit');
    await svc.listProducts({ state: 'lagos', category: 'more' });
    assert.equal(seen.at(-1).category, undefined);
    assert.deepEqual(seen.at(-1).excludeCategories, CORE_CATEGORIES);
  });
  it('refuses a made-up type with a clear error instead of showing everything', async () => {
    const { svc } = shop();
    const err = await failsWith(svc.listProducts({ state: 'lagos', category: 'portablePower' }));
    assert.equal(err.status, 400);
    assert.match(err.message, /valid product category/);
  });
});

describe('deals and the build-your-own screen only use panels, inverters and batteries', () => {
  let models, vendorSvc;
  beforeEach(() => {
    models = createMarketplaceModels();
    models.setVendor(1, 'Sun Co', 'verified');
    vendorSvc = createCatalogService(models);
  });
  it('a vendor cannot put a cable or a kit into a deal', async () => {
    const cable = await vendorSvc.createProduct(1, { ...base, category: 'cable', rating: 0, systemVoltage: null, batteryType: null, brand: null, warrantyYears: null, description: null });
    const err = await failsWith(vendorSvc.createDeal(1, { title: 'x', items: [{ productId: cable.id, qty: 1 }], buyPrice: 100000, status: 'active' }));
    assert.equal(err.code, 'INVALID_DEAL');
    assert.match(err.message, /panels, inverters and batteries/);
  });
  it('other products are never offered in the build-your-own list', async () => {
    models.productsModel.create(1, { category: 'cable', name: 'Cable', rating: 0, price: 100, inStock: true, status: 'active' });
    models.productsModel.create(1, { category: 'panel', name: 'Panel', rating: 550, price: 90000, inStock: true, status: 'active' });
    const buyable = await models.productsModel.listBuyable();
    assert.deepEqual(buyable.map((p) => p.category), ['panel']);
  });
});

describe('the browser copy of the list', () => {
  it('is identical to the server list (skipped when the client folder is not next to this one)', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../client/src/lib/productCategories.js', import.meta.url);
    if (!fs.existsSync(url)) return;
    const { clientSource } = await import('../scripts/sync-client-categories.mjs');
    assert.equal(fs.readFileSync(url, 'utf8'), clientSource(), 'Run: node scripts/sync-client-categories.mjs');
  });
});
