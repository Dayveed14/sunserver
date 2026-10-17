import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createAdminService } from '../src/modules/admin/admin.service.js';
import { createSettingsRegistry } from '../src/modules/admin/settingsRegistry.js';
import { EAAS_RULES } from '../src/modules/marketplace/eaas.js';
import { ASSUMPTIONS } from '../src/modules/analysis/pricing.js';
import { computeEaas } from '../src/modules/marketplace/eaas.js';

const clone = (o) => structuredClone(o);
const failsWith = (p) => p.then(() => null, (e) => e);

let eaas, assumptions, registry, saved, audit, vendors, users, svc;
beforeEach(() => {
  eaas = clone(EAAS_RULES);
  assumptions = clone(ASSUMPTIONS);
  registry = createSettingsRegistry({ assumptions, eaasRules: eaas });
  saved = {};
  audit = [];
  vendors = new Map([[7, { verification: 'pending' }]]);
  users = new Map([[1, { id: 1, role: 'admin', status: 'active' }], [2, { id: 2, role: 'individual', status: 'active' }]]);
  svc = createAdminService({
    registry,
    settingsRepo: {
      all: async () => ({ ...saved }),
      set: async (k, v) => { saved[k] = v; },
      remove: async (k) => { delete saved[k]; },
    },
    auditRepo: { add: async (a) => { audit.push(a); }, recent: async () => audit },
    usersRepo: { findById: async (id) => users.get(id) ?? null, setStatus: async (id, s) => { users.get(id).status = s; }, listForAdmin: async () => [] },
    vendorsRepo: {
      getProfile: async (id) => vendors.get(id) ?? null,
      setVerification: async (id, s) => { vendors.get(id).verification = s; return true; },
      listForAdmin: async () => [],
    },
  });
});

describe('pricing settings', () => {
  it('changes the live pricing objects and records it', async () => {
    await svc.saveSettings(1, { fuelPricePerLitre: 1700, eaasPlatformFee: 0.08 });
    assert.equal(assumptions.fuelPricePerLitre, 1700);
    assert.equal(eaas.platformFeePct, 0.08);
    assert.equal(saved.fuelPricePerLitre, 1700);
    assert.equal(audit[0].detail.fuelPricePerLitre.from, 1550);
  });

  it('a changed fee changes what EaaS costs', async () => {
    const terms = { components: [{ category: 'panel', cost: 1_000_000 }], installationCost: 0, installationMode: 'upfront', tenorMonths: 36, annualReturn: 0.2, segment: 'home' };
    const low = computeEaas(terms, eaas).monthly;
    await svc.saveSettings(1, { eaasPlatformFee: 0.12 });
    assert.ok(computeEaas(terms, eaas).monthly > low);
  });

  it('rejects out-of-range values and changes nothing', async () => {
    const e = await failsWith(svc.saveSettings(1, { fuelPricePerLitre: 15, eaasPlatformFee: 0.08 }));
    assert.equal(e.code, 'VALIDATION_ERROR');
    assert.ok(e.details.fields.fuelPricePerLitre);
    assert.equal(eaas.platformFeePct, 0.06);
    assert.deepEqual(saved, {});
  });

  it('keeps the return limits consistent', async () => {
    const e = await failsWith(svc.saveSettings(1, { eaasReturnMin: 0.35 })); // above current max 0.30
    assert.ok(e.details.fields.eaasReturnMax);
    const e2 = await failsWith(svc.saveSettings(1, { eaasReturnMax: 0.2 })); // below the 0.24 default
    assert.ok(e2.details.fields.eaasReturnDefault);
  });

  it('rejects unknown settings', async () => {
    assert.equal((await failsWith(svc.saveSettings(1, { nope: 1 }))).code, 'VALIDATION_ERROR');
  });

  it('null goes back to the default and flags what is customised', async () => {
    await svc.saveSettings(1, { installPct: 0.2 });
    assert.equal((await svc.listSettings()).settings.find((s) => s.key === 'installPct').custom, true);
    await svc.saveSettings(1, { installPct: null });
    const row = (await svc.listSettings()).settings.find((s) => s.key === 'installPct');
    assert.equal(row.custom, false);
    assert.equal(assumptions.solar.installPct, 0.12);
  });

  it('loads saved values on startup and ignores a bad saved set', async () => {
    saved.fuelPricePerLitre = 1800;
    saved.leftover = 5;
    assert.deepEqual(await svc.loadSettings(), { applied: 1 });
    assert.equal(assumptions.fuelPricePerLitre, 1800);
    saved.fuelPricePerLitre = 1;
    registry.reset();
    assert.deepEqual(await svc.loadSettings(), { applied: 0 });
    assert.equal(assumptions.fuelPricePerLitre, 1550);
  });
});

describe('vendors and users', () => {
  it('verifies a vendor and logs who did it', async () => {
    await svc.setVendorVerification(1, 7, 'verified');
    assert.equal(vendors.get(7).verification, 'verified');
    assert.deepEqual(audit.at(-1).detail, { from: 'pending', to: 'verified' });
  });
  it('404s for a vendor that does not exist', async () => {
    assert.equal((await failsWith(svc.setVendorVerification(1, 99, 'verified'))).status, 404);
  });
  it('suspends customers but never admins', async () => {
    await svc.setUserStatus(1, 2, 'suspended');
    assert.equal(users.get(2).status, 'suspended');
    assert.equal((await failsWith(svc.setUserStatus(1, 1, 'suspended'))).code, 'FORBIDDEN_TARGET');
  });
});
