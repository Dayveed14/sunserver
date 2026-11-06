import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { auditDraftSchema, computeAudit, missingForSubmit } from '../src/utils/auditRules.js';
import { catalogs } from '../src/utils/catalog/index.js';
import { ASSUMPTIONS } from '../src/utils/pricing.js';

const deps = { catalogs, assumptions: ASSUMPTIONS };
const first = (id) => ({ applianceId: id, variantId: catalogs.business.appliances.find((a) => a.id === id).variants[0].id });
const form = (appliances, extra = {}) => auditDraftSchema.parse({ power: { disco: 'aedc', supplyBand: 'C', usesGenerator: false }, roof: { areaM2: 200 }, appliances, ...extra });

describe('site audit rules', () => {
  it('a small site gets no energy as a service; a large one does', () => {
    const small = computeAudit(form([{ ...first('w-clipper'), qty: 2 }]), deps);
    assert.equal(small.audit.eaasEligible, false);
    assert.ok(!('eaas' in small.options));
    assert.equal(small._assessmentInput.eaasAllowed, false);
    const large = computeAudit(form([{ ...first('w-hair-dryer'), qty: 20, hoursKey: 'h10' }]), deps);
    assert.equal(large.audit.eaasEligible, true);
    assert.ok(large.options.eaas);
    assert.equal(large._assessmentInput.eaasAllowed, undefined);
  });

  it('the threshold is the admin setting', () => {
    const f = form([{ ...first('w-clipper'), qty: 2 }]);
    const kwh = computeAudit(f, deps).usage.kwhPerDay;
    const low = { ...ASSUMPTIONS, audit: { ...ASSUMPTIONS.audit, eaasMinKwhPerDay: kwh } };
    assert.equal(computeAudit(f, { ...deps, assumptions: low }).audit.eaasEligible, true, 'exactly at the threshold counts');
  });

  it('sizes: essentials only when some rows are critical; growth is always larger', () => {
    const rows = [{ ...first('w-clipper'), qty: 2, critical: true }, { ...first('w-hair-dryer'), qty: 4 }];
    const keys = computeAudit(form(rows), deps).audit.scenarios.map((s) => s.key);
    assert.deepEqual(keys, ['essentials', 'full', 'growth']);
    const none = computeAudit(form(rows.map((r) => ({ ...r, critical: false }))), deps).audit.scenarios.map((s) => s.key);
    assert.deepEqual(none, ['full', 'growth']);
    const [, full, growth] = computeAudit(form(rows), deps).audit.scenarios;
    assert.ok(growth.kwhPerDay > full.kwhPerDay);
  });

  it('flags a roof that is too small and uses fuel spend as reported', () => {
    const rows = [{ ...first('w-hair-dryer'), qty: 20, hoursKey: 'h10' }];
    const r = computeAudit(form(rows, { roof: { areaM2: 20 }, power: { disco: 'aedc', usesGenerator: true, fuelSpendPerWeek: 10000 } }), deps);
    assert.equal(r.audit.roof.fits, false);
    assert.equal(r.audit.fuel.reportedMonthly, Math.round(10000 * ASSUMPTIONS.audit.weeksPerMonth));
    assert.equal(computeAudit(form(rows, { roof: {} }), deps).audit.roof.fits, null);
  });

  it('refuses an unknown appliance or electricity company', () => {
    assert.throws(() => computeAudit(form([{ applianceId: 'nope', variantId: 'x', qty: 1 }]), deps), { code: 'UNKNOWN_APPLIANCE' });
    assert.throws(() => computeAudit(form([{ ...first('w-clipper'), qty: 1 }], { power: { disco: 'nowhere' } }), deps), { code: 'UNKNOWN_DISCO' });
  });

  it('says what is missing before submit, and asks for a generator photo only when there is a generator', () => {
    const empty = missingForSubmit(auditDraftSchema.parse({}), []);
    for (const k of ['site.gps', 'business.shopName', 'power.disco', 'appliances', 'photo.plaza', 'photo.roof', 'photo.signature']) assert.ok(empty[k], k);
    assert.ok(!empty['photo.generator']);
    const gen = missingForSubmit(auditDraftSchema.parse({ power: { usesGenerator: true } }), []);
    assert.ok(gen['photo.generator']);
    const full = auditDraftSchema.parse({
      site: { plazaName: 'P', section: 'plaza', shopStatus: 'occupied', gps: { lat: 9, lng: 7 } },
      business: { shopName: 'S', ownerFirstName: 'A', ownerPhone: '0803' },
      power: { disco: 'aedc', usesGenerator: false }, appliances: [{ applianceId: 'a', variantId: 'b', qty: 1 }],
    });
    assert.deepEqual(missingForSubmit(full, ['plaza', 'roof', 'equipment_space', 'signature']), {});
  });

  it('the draft ignores unknown fields and rejects bad values', () => {
    assert.equal(auditDraftSchema.parse({ site: { evil: 1 } }).site.evil, undefined);
    assert.throws(() => auditDraftSchema.parse({ power: { supplyBand: 'Z' } }));
    assert.throws(() => auditDraftSchema.parse({ appliances: [{ applianceId: 'a', variantId: 'b', qty: 0 }] }));
  });
});
