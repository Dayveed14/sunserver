import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createCatalogService } from '../src/services/catalog.service.js';
import { createAdminService } from '../src/services/admin.service.js';
import { createSettingsRegistry } from '../src/utils/settingsRegistry.js';
import { EAAS_RULES } from '../src/utils/eaas.js';
import { ASSUMPTIONS } from '../src/utils/pricing.js';
import { createMarketplaceModels } from '../test-support/marketplaceModels.js';

const failsWith = (p) => p.then(() => null, (e) => e);
const good = (o = {}) => ({ category: 'panel', name: 'Mono 550W', brand: 'Jinko', rating: 550, systemVoltage: null, batteryType: null, price: 95000, inStock: true, warrantyYears: 10, description: null, status: 'active', imageId: null, ...o });

// Vendor editing goes through the catalog service; admin editing through the admin service. Both share one fake products table.
let models, vendorSvc, adminSvc, audit, images;
beforeEach(() => {
  models = createMarketplaceModels();
  models.setVendor(1, 'Sun Co', 'verified');
  audit = [];
  images = new Set([5]);
  const products = models.productsModel;
  // The admin side needs "any vendor" lookups; the fake keeps products in one list, so these are thin wrappers.
  const adminProducts = {
    findAny: async (id) => (await products.findManyByIds([id]))[0] ?? null,
    listForAdmin: async () => products.listByVendor(1),
    updateAny: async (id, d) => { const p = await products.findManyByIds([id]); return p[0] ? products.update(id, p[0].vendorId, d) : false; },
    archiveAny: async (id) => { const p = await products.findManyByIds([id]); return p[0] ? products.archive(id, p[0].vendorId) : false; },
    setImage: async (id, img) => products.setImage?.(id, img),
  };
  vendorSvc = createCatalogService(models);
  adminSvc = createAdminService({
    registry: createSettingsRegistry({ assumptions: structuredClone(ASSUMPTIONS), eaasRules: structuredClone(EAAS_RULES) }),
    settingsModel: { all: async () => ({}) }, auditModel: { add: async (a) => { audit.push(a); } },
    usersModel: {}, vendorsModel: {}, productsModel: adminProducts, imagesModel: { exists: async (id) => images.has(id) },
  });
});

describe('editing products', () => {
  it('a vendor can change price, details and stock of their own product', async () => {
    const p = await vendorSvc.createProduct(1, good());
    const after = await vendorSvc.updateProduct(1, p.id, good({ price: 88000, description: 'Tier 1 cells', inStock: false }));
    assert.equal(after.price, 88000);
    assert.equal(after.description, 'Tier 1 cells');
    assert.equal(after.inStock, false);
  });

  it('a vendor cannot edit another vendor\'s product', async () => {
    const p = await vendorSvc.createProduct(1, good());
    const err = await failsWith(vendorSvc.updateProduct(2, p.id, good({ price: 1 })));
    assert.equal(err.status, 404);
  });

  it('the admin can change any product and the change is recorded with before and after', async () => {
    const p = await vendorSvc.createProduct(1, good());
    const after = await adminSvc.updateProduct(99, p.id, good({ price: 70000, status: 'hidden' }));
    assert.equal(after.price, 70000);
    assert.equal(after.status, 'hidden');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'product.update');
    assert.deepEqual(audit[0].detail.price, { from: 95000, to: 70000 });
  });

  it('the admin cannot change a product\'s type', async () => {
    const p = await vendorSvc.createProduct(1, good());
    const err = await failsWith(adminSvc.updateProduct(99, p.id, good({ category: 'inverter', rating: 1.5, systemVoltage: 24 })));
    assert.equal(err.status, 400);
  });

  it('the admin cannot attach a picture that does not exist', async () => {
    const p = await vendorSvc.createProduct(1, good());
    const err = await failsWith(adminSvc.updateProduct(99, p.id, good({ imageId: 404 })));
    assert.equal(err.code, 'VALIDATION_ERROR');
  });

  it('the admin gets "not found" for a product that is not there, and can remove one', async () => {
    assert.equal((await failsWith(adminSvc.updateProduct(99, 12345, good()))).status, 404);
    const p = await vendorSvc.createProduct(1, good());
    await adminSvc.archiveProduct(99, p.id);
    assert.equal(audit.at(-1).action, 'product.archive');
  });
});
