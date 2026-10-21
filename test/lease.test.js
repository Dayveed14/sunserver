import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEASE_RULES, leaseOptions, priceLease, validateLeaseTerms } from '../src/modules/marketplace/lease.js';
import { dealSchema } from '../src/modules/marketplace/marketplace.schemas.js';
import { planOffer, plansOffered } from '../src/modules/marketplace/matching.js';

const items = [{ productId: 1, qty: 2 }, { productId: 2, qty: 1 }, { productId: 3, qty: 1 }];

describe('lease to own, pay small small', () => {
  it('splits the balance after the deposit across the plan length', () => {
    const o = priceLease(1_000_000, { depositPct: 0.3, months: 6 });
    assert.equal(o.deposit, 300000);
    assert.equal(o.monthly, Math.ceil((1_150_000 - 300000) / 6 / 100) * 100); // 15% markup for 6 months
    assert.ok(o.totalPayable >= 1_150_000 && o.totalPayable < 1_150_000 + 600); // only rounding on top
  });

  it('longer plans pay less a month but cost more in total', () => {
    const opts = leaseOptions(1_000_000, { depositPct: 0.3, tenors: [12, 3, 6, 4] });
    assert.deepEqual(opts.map((o) => o.months), [3, 4, 6, 12]);
    for (let i = 1; i < opts.length; i++) {
      assert.ok(opts[i].monthly < opts[i - 1].monthly);
      assert.ok(opts[i].totalPayable > opts[i - 1].totalPayable);
    }
  });

  it('a bigger deposit means smaller monthly payments', () => {
    assert.ok(priceLease(1_000_000, { depositPct: 0.5, months: 6 }).monthly < priceLease(1_000_000, { depositPct: 0.2, months: 6 }).monthly);
  });

  it('only allows 3, 4, 6 or 12 months and a deposit inside the limits', () => {
    assert.ok(validateLeaseTerms({ depositPct: 0.3, tenors: [5] }).tenors);
    assert.ok(validateLeaseTerms({ depositPct: 0.3, tenors: [] }).tenors);
    assert.ok(validateLeaseTerms({ depositPct: 0.05, tenors: [3] }).depositPct);
    assert.ok(validateLeaseTerms({ depositPct: 0.9, tenors: [3] }).depositPct);
    assert.deepEqual(validateLeaseTerms({ depositPct: 0.3, tenors: [3, 12] }), {});
    assert.equal(priceLease(1_000_000, { depositPct: 0.3, months: 5 }), null);
  });

  it('the vendor picks plans and a deposit, and needs a buy price', () => {
    const base = { title: 'Starter', items, lease: { depositPct: 30, tenors: [3, 6, 12] } };
    assert.equal(dealSchema.safeParse(base).success, false); // no buy price to price from
    const ok = dealSchema.parse({ ...base, buyPrice: 900000 });
    assert.deepEqual(ok.leaseTerms, { depositPct: 0.3, tenors: [3, 6, 12] });
    assert.equal(dealSchema.safeParse({ ...base, buyPrice: 900000, lease: { depositPct: 30, tenors: [5] } }).success, false);
  });

  it('offers the lease with every plan length, headline on the longest, and honours a chosen length', () => {
    const deal = { buyPrice: 900000, leaseTerms: { depositPct: 0.3, tenors: [3, 6, 12] }, items: [] };
    const baseline = { monthlyCost: 200000 };
    const o = planOffer(deal, 'lease', baseline);
    assert.equal(o.termMonths, 12);
    assert.equal(o.leaseOptions.length, 3);
    assert.equal(planOffer(deal, 'lease', baseline, { months: 3 }).termMonths, 3);
    assert.equal(planOffer(deal, 'lease', baseline, { months: 4 }).termMonths, 12); // not offered: falls back
    assert.ok(plansOffered(deal).includes('lease'));
  });

  it('an old lease with a typed-in monthly fee still works', () => {
    const o = planOffer({ leaseDeposit: 100000, leaseMonthly: 30000, leaseMonths: 36 }, 'lease', { monthlyCost: 100000 });
    assert.equal(o.totalCost, 100000 + 30000 * 36);
  });

  it('a change to the markups changes the price', () => {
    const rules = { ...LEASE_RULES, markupPct: { ...LEASE_RULES.markupPct, 6: 0.3 } };
    assert.ok(priceLease(1_000_000, { depositPct: 0.3, months: 6 }, rules).monthly > priceLease(1_000_000, { depositPct: 0.3, months: 6 }).monthly);
  });
});
