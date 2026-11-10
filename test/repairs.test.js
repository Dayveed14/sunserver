import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPAIR_RULES, bandFor, feeFor, rankTechnicians, technicianShare } from '../src/utils/repairRules.js';
import { createSettingsRegistry } from '../src/utils/settingsRegistry.js';
import { ASSUMPTIONS } from '../src/utils/pricing.js';
import { EAAS_RULES } from '../src/utils/eaas.js';

const cust = { state: 'lagos', areaId: 'yaba' };
const tech = (id, o = {}) => ({ id, state: 'lagos', areaId: 'yaba', travelKm: 25, capacity: 2, activeJobs: 0, completedJobs: 0, rating: null, yearsExperience: 4, responseTime: '4h', ...o });

test('call-out fee follows the distance band', () => {
  assert.equal(bandFor(2), 'near'); assert.equal(bandFor(5), 'near'); assert.equal(bandFor(5.1), 'mid');
  assert.equal(bandFor(15), 'mid'); assert.equal(bandFor(30), 'far'); assert.equal(bandFor(30.1), 'beyond');
  assert.deepEqual(feeFor(10), { bandId: 'mid', fee: REPAIR_RULES.fees.mid });
  assert.deepEqual(feeFor(10, { ...REPAIR_RULES, fees: { ...REPAIR_RULES.fees, mid: 9000 } }), { bandId: 'mid', fee: 9000 });
});

test('the technician keeps what is left after the one commission', () => {
  assert.equal(technicianShare(10000), 8000);
  assert.equal(technicianShare(10000, { ...REPAIR_RULES, commissionPct: 0.1 }), 9000);
});

test('ranking: nearer, experienced and proven technicians come first; no history is allowed but ranks lower', () => {
  const ranked = rankTechnicians(cust, [
    tech(1, { areaId: 'ikeja', completedJobs: 0 }),                // farther, no history
    tech(2, { areaId: 'yaba', completedJobs: 10, yearsExperience: 11, responseTime: '1h' }), // here, proven
    tech(3, { areaId: 'surulere', completedJobs: 0 }),             // near, no history
  ]);
  assert.deepEqual(ranked.map((r) => r.id), [2, 3, 1]);
  assert.ok(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score);
  assert.ok(ranked.every((r) => typeof r.distanceKm === 'number'));
});

test('ranking: other states, out-of-range and unknown areas are not eligible; full technicians are marked, not dropped', () => {
  const ranked = rankTechnicians(cust, [
    tech(1, { state: 'abuja', areaId: 'wuse-2' }),
    tech(2, { areaId: 'ikeja', travelKm: 10 }),     // about 20 km by road: beyond their range
    tech(3, { areaId: 'nowhere' }),
    tech(4, { activeJobs: 2 }),                      // at capacity (2)
    tech(5, { capacity: null, activeJobs: 1 }),      // legacy profile: default capacity 2
  ]);
  assert.deepEqual(ranked.map((r) => r.id).sort(), [4, 5]);
  assert.equal(ranked.find((r) => r.id === 4).atCapacity, true);
  assert.equal(ranked.find((r) => r.id === 5).atCapacity, false);
});

test('ranking is stable: equal scores go to the nearer technician, then the lower id', () => {
  const ranked = rankTechnicians(cust, [tech(9), tech(3), tech(5)]);
  assert.deepEqual(ranked.map((r) => r.id), [3, 5, 9]);
});

test('settings: the repair numbers are editable and checked (distances must increase)', () => {
  const reg = createSettingsRegistry({ assumptions: structuredClone(ASSUMPTIONS), eaasRules: structuredClone(EAAS_RULES), repairRules: structuredClone(REPAIR_RULES) });
  const values = reg.current();
  assert.equal(values.repairFeeNear, REPAIR_RULES.fees.near);
  assert.deepEqual(reg.validate(values), {});
  assert.ok(reg.validate({ ...values, repairKmMid: values.repairKmNear }).repairKmMid);
  assert.ok(reg.validate({ ...values, repairFeeNear: 5 }).repairFeeNear);
  reg.apply({ ...values, repairFeeNear: 6500, repairAdminMinutes: 10 });
  assert.equal(reg.current().repairFeeNear, 6500);
  assert.equal(reg.current().repairAdminMinutes, 10);
});
