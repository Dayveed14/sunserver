import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DELIVERY_RULES, buildFeeMatrix, feeForDistance, haversineKm, quoteTrip, roadDistanceKm } from '../src/utils/delivery.js';
import { SLA_RULES, addWorkingMinutes, autoReceiveAt, estimateDelivery, formatLagos, latestOf, nextOpen } from '../src/utils/sla.js';
import { areasOf, findArea } from '../src/utils/areas.js';

describe('delivery pricing', () => {
  const vi = findArea('lagos', 'victoria-island');
  const ikeja = findArea('lagos', 'ikeja');
  const ajah = findArea('lagos', 'ajah');

  it('measures distance sensibly', () => {
    assert.ok(Math.abs(haversineKm(vi, ikeja) - 20.6) < 3); // VI to Ikeja is about 20 km as the crow flies
    assert.ok(roadDistanceKm(vi, ikeja) > haversineKm(vi, ikeja)); // roads are longer than straight lines
    assert.equal(roadDistanceKm(vi, vi), DELIVERY_RULES.minDistanceKm);
  });

  it('charges more for longer trips, within a floor and a cap, in N50 steps', () => {
    const near = feeForDistance(3);
    const far = feeForDistance(30);
    assert.ok(far > near);
    assert.ok(near >= DELIVERY_RULES.minFee);
    assert.equal(feeForDistance(5000), DELIVERY_RULES.maxFee);
    assert.equal(far % 50, 0);
  });

  it('builds a price from a vendor to every area in their state', () => {
    const matrix = buildFeeMatrix('lagos', 'victoria-island');
    assert.equal(matrix.length, areasOf('lagos').length);
    const own = matrix.find((m) => m.areaId === 'victoria-island');
    const ikorodu = matrix.find((m) => m.areaId === 'ikorodu');
    assert.ok(ikorodu.fee > own.fee);
    assert.ok(matrix.every((m) => m.fee >= DELIVERY_RULES.minFee && m.distanceKm >= 2));
  });

  it('a vendor in Muri-land style outer area costs differently from Victoria Island for the same customer', () => {
    const fromVi = quoteTrip({ from: { state: 'lagos', areaId: 'victoria-island' }, to: { state: 'lagos', areaId: 'ikeja' } });
    const fromIkorodu = quoteTrip({ from: { state: 'lagos', areaId: 'ikorodu' }, to: { state: 'lagos', areaId: 'ikeja' } });
    assert.notEqual(fromVi.fee, fromIkorodu.fee);
  });

  it('refuses interstate trips', () => {
    assert.equal(quoteTrip({ from: { state: 'lagos', areaId: 'ikeja' }, to: { state: 'abuja', areaId: 'garki' } }), null);
    assert.equal(quoteTrip({ from: { state: 'lagos', areaId: 'nowhere' }, to: { state: 'lagos', areaId: 'ikeja' } }), null);
  });

  it('a change to the rules changes the fee', () => {
    assert.ok(feeForDistance(10, { ...DELIVERY_RULES, perKm: 300 }) > feeForDistance(10));
  });
});

describe('working hours', () => {
  // 2026-10-19 is a Monday. Lagos is UTC+1, so 09:00 Lagos = 08:00Z.
  const at = (iso) => new Date(iso).getTime();
  it('waits for the morning when it is night', () => {
    assert.equal(new Date(nextOpen(at('2026-10-19T21:00:00Z'), 18)).toISOString(), '2026-10-20T07:00:00.000Z'); // 22:00 Mon -> 08:00 Tue
  });
  it('skips Sunday', () => {
    assert.equal(new Date(nextOpen(at('2026-10-24T20:00:00Z'), 18)).toISOString(), '2026-10-26T07:00:00.000Z'); // Sat evening -> Mon 08:00
  });
  it('carries work over the end of the day', () => {
    // Monday 17:30 Lagos + 60 working minutes with a 18:00 close -> 30 min left -> Tuesday 08:30
    assert.equal(new Date(addWorkingMinutes(at('2026-10-19T16:30:00Z'), 60, 18)).toISOString(), '2026-10-20T07:30:00.000Z');
  });
});

describe('delivery time promises', () => {
  const base = { distanceKm: 10, zone: 'Inner', lines: 1 };
  const monMorning = '2026-10-19T09:00:00Z'; // 10:00 Lagos, Monday
  const wait = (e) => new Date(e.promisedBy) - new Date(e.placedAt);

  it('adds up accept, prepare, ride and a cushion, and promises later than it expects', () => {
    const e = estimateDelivery({ ...base, placedAt: '2026-10-19T11:00:00Z' }); // 12:00 Lagos, no rush
    assert.ok(new Date(e.promisedBy) > new Date(e.expectedAt));
    assert.equal(e.steps.acceptMinutes, 30);
    assert.equal(e.steps.prepMinutes, 60);
    assert.equal(e.afterHours, false);
  });

  it('a farther customer waits longer', () => {
    const near = estimateDelivery({ ...base, distanceKm: 4, placedAt: monMorning });
    const far = estimateDelivery({ ...base, distanceKm: 35, placedAt: monMorning });
    assert.ok(wait(far) > wait(near));
  });

  it('rush hour slows the ride', () => {
    const rush = estimateDelivery({ ...base, distanceKm: 20, placedAt: '2026-10-19T06:00:00Z' }); // 07:00 Lagos, picked up ~08:30
    const calm = estimateDelivery({ ...base, distanceKm: 20, placedAt: '2026-10-19T10:00:00Z' }); // 11:00 Lagos, picked up ~12:30
    assert.ok(rush.steps.travelMinutes > calm.steps.travelMinutes);
  });

  it('an order at midnight is not promised within the hour: it starts when the vendor opens', () => {
    const e = estimateDelivery({ ...base, placedAt: '2026-10-19T23:00:00Z' }); // midnight Lagos
    assert.equal(e.afterHours, true);
    assert.ok(new Date(e.acceptBy) >= new Date('2026-10-20T07:30:00Z')); // 08:30 Lagos at the earliest
    assert.ok(new Date(e.promisedBy) - new Date(e.placedAt) > 8 * 3600 * 1000);
  });

  it('a late afternoon order rolls to the next day when the riders have stopped', () => {
    const e = estimateDelivery({ ...base, placedAt: '2026-10-19T16:30:00Z' }); // 17:30 Lagos
    assert.ok(new Date(e.promisedBy) >= new Date('2026-10-20T07:00:00Z'));
  });

  it('more kinds of item take longer to prepare', () => {
    assert.ok(estimateDelivery({ ...base, lines: 4, placedAt: monMorning }).steps.prepMinutes > estimateDelivery({ ...base, placedAt: monMorning }).steps.prepMinutes);
  });

  it('with several vendors the customer is promised the latest', () => {
    const a = estimateDelivery({ ...base, distanceKm: 4, placedAt: monMorning });
    const b = estimateDelivery({ ...base, distanceKm: 35, placedAt: monMorning });
    assert.equal(latestOf([a, b]), b);
  });

  it('formats times in Lagos time', () => {
    const now = new Date('2026-10-19T09:00:00Z');
    assert.equal(formatLagos('2026-10-19T13:15:00Z', now), 'Today, 2:15 PM');
    assert.equal(formatLagos('2026-10-20T08:30:00Z', now), 'Tomorrow, 9:30 AM');
  });

  it('counts a delivered order as received after twelve hours', () => {
    assert.equal(autoReceiveAt('2026-10-19T10:00:00Z', SLA_RULES).toISOString(), '2026-10-19T22:00:00.000Z');
  });
});

import { createFeesService } from '../src/services/deliveryFees.service.js';

describe('vendor delivery prices', () => {
  const memory = () => {
    const rows = new Map(); // vendorId -> rows
    const locs = new Map();
    return {
      rows,
      locs,
      model: {
        async replaceForVendor(id, list) { rows.set(id, list); },
        async forVendors(ids) { return ids.flatMap((id) => (rows.get(id) ?? []).map((r) => ({ vendorId: id, ...r }))); },
        async vendorLocations() { return [...locs.values()]; },
        async vendorLocation(id) { return locs.get(id) ?? null; },
      },
    };
  };

  it('saves a price from a vendor to every area in their state', async () => {
    const m = memory();
    const svc = createFeesService({ model: m.model });
    assert.equal(await svc.refreshVendor(1, { vendorId: 1, state: 'lagos', areaId: 'victoria-island' }), areasOf('lagos').length);
    assert.equal(m.rows.get(1).length, areasOf('lagos').length);
  });

  it('quotes each vendor separately, so two vendors give two fees', async () => {
    const m = memory();
    const svc = createFeesService({ model: m.model });
    const vendors = [
      { vendorId: 1, state: 'lagos', areaId: 'victoria-island' },
      { vendorId: 2, state: 'lagos', areaId: 'ikorodu' },
    ];
    for (const v of vendors) await svc.refreshVendor(v.vendorId, v);
    const { fees, unreachable } = await svc.quote(vendors, { state: 'lagos', areaId: 'ikeja' });
    assert.equal(unreachable.length, 0);
    assert.notEqual(fees.get(1).fee, fees.get(2).fee);
    assert.equal(fees.get(1).zone, 'Central');
  });

  it('cannot deliver across states', async () => {
    const m = memory();
    const svc = createFeesService({ model: m.model });
    const { fees, unreachable } = await svc.quote([{ vendorId: 1, state: 'lagos', areaId: 'ikeja' }], { state: 'abuja', areaId: 'garki' });
    assert.equal(fees.size, 0);
    assert.deepEqual(unreachable, [1]);
  });

  it('works a price out on the spot for a vendor with none saved yet, and keeps it', async () => {
    const m = memory();
    const svc = createFeesService({ model: m.model });
    const { fees } = await svc.quote([{ vendorId: 9, state: 'abuja', areaId: 'garki' }], { state: 'abuja', areaId: 'kubwa' });
    assert.ok(fees.get(9).fee >= 1500);
    assert.ok(m.rows.get(9).length > 0);
  });

  it('works every vendor out again when the rules change', async () => {
    const m = memory();
    m.locs.set(1, { vendorId: 1, state: 'lagos', areaId: 'ikeja' });
    m.locs.set(2, { vendorId: 2, state: 'abuja', areaId: 'garki' });
    const svc = createFeesService({ model: m.model });
    assert.equal(await svc.recomputeAll(), 2);
    assert.ok(m.rows.has(1) && m.rows.has(2));
  });
});
