import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnalysisService } from '../src/services/analysis.service.js';
import { estimate } from '../src/utils/calculator.js';
import { catalogs } from '../src/utils/catalog/index.js';
import { ASSUMPTIONS } from '../src/utils/pricing.js';
import { PRIORITIES, publicPriorities } from '../src/utils/priorities.js';
import { estimateSchema, interestSchema } from '../src/validators/analysis.schemas.js';

const svc = createAnalysisService({ assessmentsModel: {} });
const deps = { catalogs, assumptions: ASSUMPTIONS };
const dv = (id) => { const ap = catalogs.home.appliances.find((a) => a.id === id); return (ap.variants.find((v) => v.default) ?? ap.variants[0]).id; };
const item = (id, qty, hoursKey) => ({ applianceId: id, variantId: dv(id), qty, ...(hoursKey ? { hoursKey } : {}) });
const home = (extra = {}) => ({
  segment: 'home', disco: 'aedc', supplyBand: 'D',
  items: [item('led-bulb', 8, 'h7'), item('ceiling-fan', 3, 'h10'), item('fridge', 1), item('tv', 1, 'h4'), item('kettle', 1, 'h05'), item('ac', 1, 'h7')],
  ...extra,
});

test('a request with none of the new answers gives the same result as before, with no configurations', () => {
  const r = svc.estimate(home());
  assert.equal(r.configurations, undefined);
  assert.equal(r.solar.backupHours, null);
  assert.deepEqual(r.solar, { ...estimate(home(), deps).solar });
});

test('a longer backup time makes the battery bigger, never smaller', () => {
  const short = estimate({ ...home(), backupHours: 4 }, deps).solar;
  const long = estimate({ ...home(), backupHours: 24 }, deps).solar;
  assert.ok(long.batteryKwh >= short.batteryKwh);
  assert.ok(long.backupKwh > short.backupKwh);
});

test('three configurations are priced and ordered from smallest to largest', () => {
  const r = svc.estimate(home({ backupKey: 'b6', priorities: ['food', 'lights_fans'] }));
  const keys = r.configurations.items.map((c) => c.key);
  assert.deepEqual(keys, ['essential', 'comfortable', 'whole']);
  const costs = r.configurations.items.map((c) => c.systemCost);
  assert.ok(costs[0] <= costs[1] && costs[1] < costs[2]);
  assert.equal(r.configurations.recommended, 'comfortable');
  assert.equal(r.configurations.selected, 'comfortable');
  // the headline numbers belong to the selected configuration
  assert.equal(r.solar.systemCost, r.configurations.items[1].systemCost);
  assert.ok(r.configurations.items[0].leftOut.includes('Air conditioner'));
});

test('ticking the air conditioner as a priority keeps it out of essential but inside comfortable', () => {
  const r = svc.estimate(home({ backupKey: 'b6', priorities: ['food', 'ac'] }));
  const by = Object.fromEntries(r.configurations.items.map((c) => [c.key, c]));
  assert.ok(!by.essential.runs.includes('Air conditioner'));
  assert.ok(by.comfortable.runs.includes('Air conditioner'));
});

test('"reduce generator use" suggests the whole property; "continuous" and medical suggest essential', () => {
  assert.equal(svc.estimate(home({ backupKey: 'b6', priorities: ['reduce_fuel'] })).configurations.recommended, 'whole');
  assert.equal(svc.estimate(home({ backupKey: 'cont', priorities: ['food'] })).configurations.recommended, 'essential');
  assert.equal(svc.estimate(home({ backupKey: 'b6', priorities: ['medical'] })).configurations.recommended, 'essential');
});

test('a medical priority gives the essential system at least 12 hours of backup', () => {
  const r = svc.estimate(home({ backupKey: 'b4', priorities: ['medical'] }));
  assert.ok(r.configurations.items.find((c) => c.key === 'essential').backupHours >= 12);
});

test('the budget steps the suggestion down to what fits, and says when nothing does', () => {
  const full = svc.estimate(home({ backupKey: 'b6', priorities: ['reduce_fuel'] }));
  const mid = full.configurations.items.find((c) => c.key === 'comfortable').systemCost;
  const fits = svc.estimate(home({ backupKey: 'b6', priorities: ['reduce_fuel'], budget: mid + 1000 }));
  assert.equal(fits.configurations.recommended, 'comfortable');
  assert.equal(fits.configurations.items.find((c) => c.key === 'whole').fitsBudget, false);
  assert.ok(fits.configurations.items.find((c) => c.key === 'whole').overBy > 0);
  const none = svc.estimate(home({ backupKey: 'b6', budget: 10000 }));
  assert.equal(none.configurations.nothingFits, true);
  assert.equal(none.configurations.recommended, 'essential');
});

test('choosing a configuration prices that one, and an unknown one falls back to the suggestion', () => {
  const base = home({ backupKey: 'b6', priorities: ['food'] });
  const whole = svc.estimate({ ...base, configKey: 'whole' });
  const essential = svc.estimate({ ...base, configKey: 'essential' });
  assert.ok(whole.solar.systemCost > essential.solar.systemCost);
  assert.equal(whole.configurations.selected, 'whole');
  const onlyOne = svc.estimate({ ...base, items: base.items.slice(0, 1), configKey: 'comfortable' });
  assert.ok(onlyOne.configurations.items.some((c) => c.key === onlyOne.configurations.selected));
});

test('identical configurations are shown once', () => {
  const r = svc.estimate({ ...home(), items: home().items.slice(0, 2), backupKey: 'b6', priorities: ['lights_fans'] });
  const sigs = r.configurations.items.map((c) => `${c.kwp}|${c.batteryKwh}|${c.inverterKva}`);
  assert.equal(new Set(sigs).size, sigs.length);
});

test('every priority points at real catalogue items, and each segment only lists priorities it can serve', () => {
  for (const seg of ['home', 'business']) {
    const ids = new Set(catalogs[seg].appliances.map((a) => a.id));
    for (const p of publicPriorities(catalogs[seg])) for (const id of p.applianceIds) assert.ok(ids.has(id), `${seg}: ${id}`);
  }
  for (const p of PRIORITIES.filter((x) => x.ids)) {
    const known = [...p.ids].filter((id) => catalogs.home.appliances.some((a) => a.id === id) || catalogs.business.appliances.some((a) => a.id === id));
    assert.deepEqual([...p.ids].filter((id) => !known.includes(id)), [], `${p.id} lists an item that does not exist`);
  }
});

test('the public catalogue carries the backup choices and priorities, never watts', () => {
  const c = svc.publicCatalog('home');
  assert.equal(c.backupOptions.length, 6);
  assert.ok(c.priorities.length >= 6);
  assert.ok(!JSON.stringify(c).includes('watts'));
});

test('the new answers are checked: unknown priorities and backup keys are refused', () => {
  const ok = estimateSchema.safeParse({ ...home(), backupKey: 'b6', priorities: ['food'], who: 'home', configKey: 'auto' });
  assert.equal(ok.success, true);
  assert.equal(estimateSchema.safeParse({ ...home(), priorities: ['nonsense'] }).success, false);
  assert.equal(estimateSchema.safeParse({ ...home(), backupKey: 'b99' }).success, false);
});

test('notify-me accepts only the categories that are not live and a real email', () => {
  assert.equal(interestSchema.safeParse({ category: 'cng', email: 'A@Example.com' }).data.email, 'a@example.com');
  assert.equal(interestSchema.safeParse({ category: 'solar', email: 'a@example.com' }).success, false);
  assert.equal(interestSchema.safeParse({ category: 'cng', email: 'nope' }).success, false);
});

test('the new medical home items exist and count towards the medical priority', () => {
  const r = svc.estimate({ segment: 'home', disco: 'aedc', supplyBand: 'D', backupKey: 'b6', priorities: ['medical'], items: [
    item('oxygen-concentrator', 1, 'h10'), item('led-bulb', 4, 'h7'), item('kettle', 1, 'h05'),
  ] });
  assert.ok(r.configurations.items.some((c) => c.key === 'essential' && c.runs.includes('Oxygen concentrator')));
});

// ---- 10b: fitted to a budget ----
const fitted = (budget, extra = {}) => svc.estimate(home({ backupKey: 'b6', priorities: ['food', 'lights_fans', 'ac'], configKey: 'auto', budget, ...extra }));
const budgetCard = (r) => r.configurations.items.find((c) => c.key === 'budget');

test('a budget below the whole site adds a "fitted" option that costs no more than the budget', () => {
  const r = fitted(1_200_000);
  const b = budgetCard(r);
  assert.ok(b, 'a fitted option exists');
  assert.ok(b.systemCost <= 1_200_000);
  assert.equal(b.fitsBudget, true);
  assert.equal(r.configurations.recommended, 'budget');
  assert.equal(r.solar.systemCost, b.systemCost, 'the page prices the fitted option when it is the suggestion');
});

test('the fitted option follows the order of priorities and trims quantities before dropping things', () => {
  const b = budgetCard(fitted(1_200_000));
  assert.ok(b.runs.includes('Refrigerator'), 'food is the first priority, so the fridge comes first');
  assert.ok(!b.runs.includes('Air conditioner'));
  const bulbs = b.partial.find((p) => p.name === 'LED bulbs');
  assert.ok(bulbs && bulbs.qty < bulbs.wanted && bulbs.qty >= 1);
  assert.ok(b.leftOut.includes('Air conditioner'));
});

test('a bigger budget buys a bigger system, and never goes over', () => {
  let last = 0;
  for (const budget of [1_100_000, 1_500_000, 2_500_000, 4_000_000, 6_000_000]) {
    const b = budgetCard(fitted(budget));
    assert.ok(b.systemCost <= budget, `${budget}: stays within the budget`);
    assert.ok(b.systemCost >= last, `${budget}: at least as big as the one before`);
    last = b.systemCost;
  }
  // priorities decide what gets in: with room for the air conditioner it comes before the lower-priority kettle and TV
  assert.ok(budgetCard(fitted(6_000_000)).runs.includes('Air conditioner'));
});

test('"what a little more would add" names the next item and costs something', () => {
  const b = budgetCard(fitted(2_500_000));
  assert.equal(b.next.name, 'Air conditioner');
  assert.ok(b.next.extra > 0);
});

test('with no budget, or one that covers everything, there is no fitted option', () => {
  assert.equal(budgetCard(svc.estimate(home({ backupKey: 'b6', priorities: ['food'] }))), undefined);
  assert.equal(budgetCard(fitted(50_000_000)), undefined);
});

test('a budget too small for any system says what leasing or renting would take', () => {
  const r = fitted(5_000);
  assert.equal(r.configurations.nothingFits, true);
  assert.equal(budgetCard(r), undefined);
  const f = r.configurations.fallback;
  assert.ok(f.smallestCost > 5_000 && f.leaseUpfront > 0 && f.leaseMonthly > 0 && f.rentMonthly > 0);
});

test('choosing the fitted option by name prices exactly that option', () => {
  const r = fitted(1_200_000, { configKey: 'essential' });
  const b = budgetCard(r);
  const again = fitted(1_200_000, { configKey: 'budget' });
  assert.equal(again.configurations.selected, 'budget');
  assert.equal(again.solar.systemCost, b.systemCost);
});

test('asking for the fitted option when there is none falls back to the suggestion', () => {
  const r = svc.estimate(home({ backupKey: 'b6', priorities: ['food'], configKey: 'budget' }));
  assert.equal(r.configurations.selected, r.configurations.recommended);
});
