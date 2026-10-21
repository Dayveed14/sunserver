import { allAreas, areasOf, findArea } from './areas.js';

// How delivery is priced. All numbers are placeholders until the logistics partner's rate card is agreed;
// an admin can change them (Admin > Pricing & rules > Delivery) without a release.
export const DELIVERY_RULES = {
  // Straight-line distance understates real driving distance. Roads wind, bridges and one-ways add to it.
  roadFactor: 1.35,
  // Distance never counts as less than this, even inside one area.
  minDistanceKm: 2,
  baseFee: 1200, // N, the cost of a rider showing up
  perKm: 130, // N per kilometre travelled
  minFee: 1500,
  maxFee: 25000,
  roundTo: 50, // fees are rounded up to the nearest N50
};

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

// Straight-line distance between two points, in kilometres.
export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

// Estimated road distance between two areas.
export function roadDistanceKm(from, to, rules = DELIVERY_RULES) {
  const km = haversineKm(from, to) * rules.roadFactor;
  return Math.round(Math.max(km, rules.minDistanceKm) * 10) / 10;
}

// What the rider costs for a trip of this length.
export function feeForDistance(km, rules = DELIVERY_RULES) {
  const raw = rules.baseFee + rules.perKm * km;
  const clamped = Math.min(rules.maxFee, Math.max(rules.minFee, raw));
  return Math.ceil(clamped / rules.roundTo) * rules.roundTo;
}

// Prices a trip from a vendor's area to every area in their state. Saved per vendor when they register or move.
export function buildFeeMatrix(stateId, areaId, rules = DELIVERY_RULES) {
  const from = findArea(stateId, areaId);
  if (!from) return [];
  return areasOf(stateId).map((to) => {
    const distanceKm = roadDistanceKm(from, to, rules);
    return { areaId: to.id, distanceKm, fee: feeForDistance(distanceKm, rules) };
  });
}

// One trip: where from, where to, how far, how much. Null when the two are in different states (no interstate delivery yet).
export function quoteTrip({ from, to }, rules = DELIVERY_RULES) {
  if (!from || !to || from.state !== to.state) return null;
  const a = findArea(from.state, from.areaId);
  const b = findArea(to.state, to.areaId);
  if (!a || !b) return null;
  const distanceKm = roadDistanceKm(a, b, rules);
  return { distanceKm, fee: feeForDistance(distanceKm, rules), zone: b.zone };
}

export const AREA_COUNT = allAreas().length;
