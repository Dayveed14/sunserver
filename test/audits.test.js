import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GPS_MAX_ACCURACY_M, auditDraftSchema, computeAudit, missingForSubmit, straightKm, upgradeForm } from '../src/utils/auditRules.js';
import { catalogs } from '../src/utils/catalog/index.js';
import { ASSUMPTIONS } from '../src/utils/pricing.js';

const deps = { catalogs, assumptions: ASSUMPTIONS };
const first = (id) => ({ applianceId: id, variantId: catalogs.business.appliances.find((a) => a.id === id).variants[0].id });
const form = (appliances, extra = {}) => auditDraftSchema.parse({ power: { disco: 'aedc', supplyBand: 'C', noOtherSources: true }, roof: { areaM2: 200 }, appliances, ...extra });

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
    const r = computeAudit(form(rows, { roof: { areaM2: 20 }, power: { disco: 'aedc', sources: [{ kind: 'generator', fuelSpendPerWeek: 6000 }, { kind: 'generator', fuelSpendPerWeek: 4000 }] } }), deps);
    assert.equal(r.audit.roof.fits, false);
    assert.equal(r.audit.fuel.reportedMonthly, Math.round(10000 * ASSUMPTIONS.audit.weeksPerMonth));
    assert.equal(computeAudit(form(rows, { roof: {} }), deps).audit.roof.fits, null);
  });

  it('refuses an unknown appliance or electricity company', () => {
    assert.throws(() => computeAudit(form([{ applianceId: 'nope', variantId: 'x', qty: 1 }]), deps), { code: 'UNKNOWN_APPLIANCE' });
    assert.throws(() => computeAudit(form([{ ...first('w-clipper'), qty: 1 }], { power: { disco: 'nowhere' } }), deps), { code: 'UNKNOWN_DISCO' });
  });

  it('says what is missing before submit, and asks for a generator photo only when a generator is listed', () => {
    const empty = missingForSubmit(auditDraftSchema.parse({}), []);
    for (const k of ['site.siteName', 'site.siteType', 'site.gps', 'client.firstName', 'power.disco', 'power.sources', 'appliances', 'photo.checkin', 'photo.building', 'photo.roof', 'photo.signature', 'photo.agent_signature']) assert.ok(empty[k], k);
    assert.ok(!empty['photo.generator']);
    const gen = missingForSubmit(auditDraftSchema.parse({ power: { sources: [{ kind: 'generator' }] } }), []);
    assert.ok(gen['photo.generator']);
    assert.ok(!gen['power.sources'], 'a listed source answers the question');
    const solarOnly = missingForSubmit(auditDraftSchema.parse({ power: { sources: [{ kind: 'solar', kwp: 3 }] } }), []);
    assert.ok(!solarOnly['photo.generator'], 'no generator, no generator photo');
    const full = auditDraftSchema.parse({
      site: { siteName: 'Ade Phones', siteType: 'shop', gps: { lat: 9, lng: 7, accuracyM: 12 } },
      client: { firstName: 'A', phone: '0803' },
      power: { disco: 'aedc', noOtherSources: true }, appliances: [{ applianceId: 'a', variantId: 'b', qty: 1 }],
    });
    const slots = ['checkin', 'building', 'roof', 'equipment_space', 'signature', 'agent_signature'];
    assert.deepEqual(missingForSubmit(full, slots), {});
    assert.deepEqual(missingForSubmit(full, slots.map((k) => (k === 'building' ? 'plaza' : k))), {}, 'an old "plaza" picture counts as the building picture');
  });

  it('GPS must be accurate enough to count as proof of the visit', () => {
    const base = { site: { siteName: 'S', siteType: 'home' }, client: { firstName: 'A', phone: '1' }, power: { disco: 'aedc', noOtherSources: true }, appliances: [{ applianceId: 'a', variantId: 'b', qty: 1 }] };
    const at = (gps) => missingForSubmit(auditDraftSchema.parse({ ...base, site: { ...base.site, gps } }), []);
    assert.ok(!at({ lat: 9, lng: 7, accuracyM: GPS_MAX_ACCURACY_M })['site.gps'], 'exactly at the limit is fine');
    assert.match(at({ lat: 9, lng: 7, accuracyM: GPS_MAX_ACCURACY_M + 1 })['site.gps'], /too rough/);
    assert.match(at({ lat: 9, lng: 7 })['site.gps'], /no accuracy/);
  });

  it('flagging a technical review needs a reason', () => {
    const f = (review) => missingForSubmit(auditDraftSchema.parse({ review }), []);
    assert.ok(f({ needsTechnical: true, reason: 'short' })['review.reason']);
    assert.ok(!f({ needsTechnical: true, reason: 'Three-phase supply and a cracked roof slab' })['review.reason']);
    assert.ok(!f({ needsTechnical: false })['review.reason']);
  });

  it('an old plaza form is upgraded without losing anything', () => {
    const old = {
      site: { plazaName: 'Ceddi Plaza', section: 'kiosk', shopNumber: '14', shopStatus: 'unoccupied', gps: { lat: 9.06, lng: 7.49, accuracyM: 8 } },
      business: { shopName: 'Ade Phones', ownerFirstName: 'Ade', ownerLastName: 'Bello', ownerPhone: '0803', businessType: 'Phone shop', yearsInPlaza: 4 },
      power: { disco: 'aedc', supplyBand: 'C', usesGenerator: true, generatorType: 'petrol', generatorKva: 5, fuelSpendPerWeek: 40000, otherEnergy: 'shared plaza generator', landlordContact: 'Mr X' },
      roof: { areaM2: 40, type: 'flat' }, appliances: [{ applianceId: 'w-clipper', variantId: 'v', qty: 2, critical: true }], comments: 'Friendly.',
    };
    const up = upgradeForm(old);
    assert.equal(up.v, 2);
    assert.equal(up.site.siteName, 'Ceddi Plaza');
    assert.equal(up.site.occupancy, 'vacant');
    assert.deepEqual(up.site.legacy, { section: 'kiosk', shopNumber: '14' });
    assert.equal(up.client.organisation, 'Ade Phones');
    assert.equal(up.client.firstName, 'Ade');
    assert.equal(up.client.yearsAtSite, 4);
    assert.deepEqual(up.power.sources.map((x) => x.kind), ['generator', 'other']);
    assert.equal(up.power.sources[0].fuelSpendPerWeek, 40000);
    assert.equal(up.power.landlordContact, 'Mr X');
    assert.equal(up.appliances[0].critical, true);
    assert.equal(up.comments, 'Friendly.');
    assert.deepEqual(old.site.plazaName, 'Ceddi Plaza', 'the stored form is never changed');
    assert.equal(upgradeForm(up).site.siteName, 'Ceddi Plaza', 'upgrading twice changes nothing');
    const noGen = upgradeForm({ power: { disco: 'aedc', usesGenerator: false } });
    assert.equal(noGen.power.noOtherSources, true);
    assert.equal(upgradeForm(null).v, 2);
    assert.equal(upgradeForm({}).power.noOtherSources ?? null, null, 'an empty draft stays unanswered');
  });

  it('straight-line distance is sensible', () => {
    assert.ok(Math.abs(straightKm({ lat: 9.07, lng: 7.4 }, { lat: 9.07, lng: 7.4 })) < 0.001);
    const d = straightKm({ lat: 6.5, lng: 3.35 }, { lat: 9.07, lng: 7.4 });
    assert.ok(d > 500 && d < 600, `Lagos to Abuja is about 520 km, got ${d}`);
  });

  it('the draft ignores unknown fields and rejects bad values', () => {
    assert.equal(auditDraftSchema.parse({ site: { evil: 1 } }).site.evil, undefined);
    assert.throws(() => auditDraftSchema.parse({ v: 1 }));
    assert.throws(() => auditDraftSchema.parse({ site: { siteType: 'castle' } }));
    assert.throws(() => auditDraftSchema.parse({ power: { sources: [{ kind: 'nuclear' }] } }));
    assert.throws(() => auditDraftSchema.parse({ power: { supplyBand: 'Z' } }));
    assert.throws(() => auditDraftSchema.parse({ appliances: [{ applianceId: 'a', variantId: 'b', qty: 0 }] }));
  });
});
