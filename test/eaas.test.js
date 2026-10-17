import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EAAS_RULES, computeEaas, validateEaasTerms } from '../src/modules/marketplace/eaas.js';
import { planOffer, plansOffered } from '../src/modules/marketplace/matching.js';

const base = (over = {}) => ({
  components: [
    { category: 'panel', cost: 600000 },
    { category: 'inverter', cost: 400000 },
    { category: 'battery', cost: 900000, batteryType: 'lithium' },
  ],
  installationCost: 200000,
  installationMode: 'upfront',
  tenorMonths: 36,
  annualReturn: 0.24,
  segment: 'home',
  kwhPerMonth: 300,
  ...over,
});

describe('eaas pricing', () => {
  it('monthly is the sum of its parts and the fee is 6% of the total', () => {
    const q = computeEaas(base());
    const b = q.breakdown;
    assert.equal(q.monthly, b.capital + b.operating.total + b.risk + b.platformFee);
    assert.ok(Math.abs(b.platformFee / q.monthly - EAAS_RULES.platformFeePct) < 0.002);
  });

  it('capital recovery follows the annuity formula when there is no residual', () => {
    const q = computeEaas(base({ tenorMonths: 120, components: [{ category: 'panel', cost: 1000000 }], installationCost: 0 }));
    const r = (1 + 0.24) ** (1 / 12) - 1;
    const resid = 1000000 * (1 - 120 / 300) * 0.5;
    const expected = ((1000000 - resid / (1 + r) ** 120) * r) / (1 - (1 + r) ** -120);
    assert.ok(Math.abs(q.breakdown.capital - expected) < 2);
  });

  it('longer contracts cost less a month and more in total', () => {
    const a = computeEaas(base({ tenorMonths: 24 }));
    const b = computeEaas(base({ tenorMonths: 60 }));
    assert.ok(b.monthly < a.monthly);
    assert.ok(b.totalPayable > a.totalPayable);
  });

  it('a higher return raises the price', () => {
    assert.ok(computeEaas(base({ annualReturn: 0.3 })).monthly > computeEaas(base({ annualReturn: 0.15 })).monthly);
  });

  it('paying installation at install lowers the monthly; rolling it in raises it', () => {
    const up = computeEaas(base());
    const rolled = computeEaas(base({ installationMode: 'rolled' }));
    assert.equal(up.installation.payAtInstall, 200000);
    assert.equal(rolled.installation.payAtInstall, 0);
    assert.ok(rolled.monthly > up.monthly);
  });

  it('adds a battery replacement reserve only when the contract outlives the battery', () => {
    const lead = [{ category: 'battery', cost: 900000, batteryType: 'lead' }];
    assert.equal(computeEaas(base({ components: lead, tenorMonths: 36 })).breakdown.operating.batteryReserve, 0);
    assert.ok(computeEaas(base({ components: lead, tenorMonths: 84 })).breakdown.operating.batteryReserve > 0);
  });

  it('businesses carry a lower risk allowance than homes', () => {
    assert.ok(computeEaas(base({ segment: 'business' })).breakdown.risk < computeEaas(base()).breakdown.risk);
  });

  it('early exit amounts fall over time', () => {
    const { exitSchedule } = computeEaas(base({ tenorMonths: 60 }));
    assert.ok(exitSchedule.length >= 3);
    for (let i = 1; i < exitSchedule.length; i++) assert.ok(exitSchedule[i].amount <= exitSchedule[i - 1].amount);
  });

  it('deposit is one month', () => {
    const q = computeEaas(base());
    assert.equal(q.deposit, q.monthly);
  });

  it('enforces tenor and return bounds', () => {
    assert.ok(validateEaasTerms({ tenorMonths: 6, annualReturn: 0.24 }).tenorMonths);
    assert.ok(validateEaasTerms({ tenorMonths: 36, annualReturn: 0.5 }).annualReturn);
    assert.ok(validateEaasTerms({ tenorMonths: 36, annualReturn: 0.05 }).annualReturn);
    assert.deepEqual(validateEaasTerms({ tenorMonths: 36, annualReturn: 0.24 }), {});
  });
});

describe('eaas in deals', () => {
  const items = [
    { category: 'panel', price: 150000, qty: 4 },
    { category: 'inverter', price: 400000, qty: 1 },
    { category: 'battery', price: 900000, qty: 1, batteryType: 'lithium' },
  ];
  const deal = {
    items,
    eaasTerms: { tenorMonths: 36, annualReturn: 0.24, equipmentCost: null, installationCost: 150000, installationMode: 'upfront', overagePerKwh: 180 },
  };
  it('prices the plan from the vendor terms and shows the installation due', () => {
    const o = planOffer(deal, 'eaas', { monthlyCost: 200000, segment: 'home', kwhPerMonth: 300 });
    assert.equal(o.upfront, 150000);
    assert.equal(o.termMonths, 36);
    assert.ok(o.monthly > 0 && o.eaas.breakdown.capital > 0);
    assert.equal(o.overagePerKwh, 180);
  });
  it('is offered even when the baseline has no segment', () => {
    assert.ok(plansOffered(deal).includes('eaas'));
  });
});
