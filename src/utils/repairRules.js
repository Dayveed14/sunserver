import { roadDistanceKm } from './delivery.js';
import { findArea } from './areas.js';

// Repairs. The customer pays a fixed call-out fee up front, set by how far the technician must travel. Any work beyond
// the visit is quoted on site by the technician and paid in the app. The admin edits these numbers
// (Pricing & rules → Repairs). The fees below are placeholders until real figures are agreed.
export const REPAIR_RULES = {
  fees: { near: 5000, mid: 8000, far: 12000, beyond: 18000 }, // naira, by distance band
  bandKm: { near: 5, mid: 15, far: 30 }, // a trip up to this many km (road distance) falls in the band
  commissionPct: 0.2, // TerraVoltix's share of both the call-out fee and the repair
  adminMinutes: 30, // the admin has this long to act on a recommendation before it is approved automatically
  technicianMinutes: 60, // a technician has this long to answer an offer before it moves to the next one
  confirmHours: 48, // the customer has this long to confirm a finished repair before it closes by itself
  noShowHours: 3, // a technician who has not arrived this long after "on my way" counts as a no-show (full refund)
};

export const FEE_BANDS = [
  { id: 'near', label: 'Close by' },
  { id: 'mid', label: 'Across town' },
  { id: 'far', label: 'Far side of town' },
  { id: 'beyond', label: 'Long trip' },
];

export const FAULT_TYPES = [
  { id: 'no_power', label: 'No power from the system' },
  { id: 'inverter', label: 'Inverter fault or alarm' },
  { id: 'battery', label: 'Battery not holding charge' },
  { id: 'panels', label: 'Panels damaged or giving little power' },
  { id: 'wiring', label: 'Wiring, breaker or sparking' },
  { id: 'noise_heat', label: 'Noise, smell or overheating' },
  { id: 'monitoring', label: 'Monitoring or display problem' },
  { id: 'other', label: 'Something else' },
];
export const EQUIPMENT = [
  { id: 'inverter', label: 'Inverter' },
  { id: 'battery', label: 'Battery' },
  { id: 'panels', label: 'Solar panels' },
  { id: 'controller', label: 'Charge controller' },
  { id: 'wiring', label: 'Cables and breakers' },
  { id: 'generator', label: 'Generator changeover' },
  { id: 'other', label: 'Other equipment' },
];
export const URGENCY = [
  { id: 'normal', label: 'Normal: within a few days' },
  { id: 'urgent', label: 'Urgent: as soon as possible' },
];
export const MAX_FAULT_PHOTOS = 4;
export const MAX_INSPECTION_PHOTOS = 6;
export const MAX_COMPLETION_PHOTOS = 6;

// A short notice shown at every payment step.
export const PAY_IN_APP_NOTICE = 'Pay only inside TerraVoltix. If you pay a technician directly, we cannot protect your money or help if something goes wrong.';

export const bandFor = (km, rules = REPAIR_RULES) => (km <= rules.bandKm.near ? 'near' : km <= rules.bandKm.mid ? 'mid' : km <= rules.bandKm.far ? 'far' : 'beyond');
export const feeFor = (km, rules = REPAIR_RULES) => { const id = bandFor(km, rules); return { bandId: id, fee: rules.fees[id] }; };

// What a technician keeps of an amount the customer paid.
export const technicianShare = (amount, rules = REPAIR_RULES) => Math.round(amount * (1 - rules.commissionPct));

// "More than 50 km" in the registration form is stored as 100.
const RESPONSE_PTS = { '1h': 15, '4h': 11, '24h': 5, '48h': 2 };

// Distance between a customer's area and a technician's area, by road, in km. Null when either area is unknown.
export function distanceBetween(a, b) {
  const from = a && findArea(a.state, a.areaId);
  const to = b && findArea(b.state, b.areaId);
  return from && to ? roadDistanceKm(from, to) : null;
}

// Eligibility and ranking. `candidates` are verified technicians who take repairs; each has
// { id, state, areaId, travelKm, capacity, activeJobs, completedJobs, rating, yearsExperience, responseTime }.
// Out of range or in another state: not eligible. Full: eligible but not queued (the admin can still pick them).
// No history is allowed; it just earns fewer points than a proven record. Same score: nearer first, then lower id.
export function rankTechnicians(job, candidates) {
  const rows = [];
  for (const c of candidates) {
    if (c.state !== job.state) continue;
    const km = distanceBetween(job, c);
    const range = c.travelKm ?? 25;
    if (km == null || km > range) continue;
    const distancePts = 40 * (1 - Math.min(km, range) / range);
    const historyPts = 20 * (Math.min(c.completedJobs ?? 0, 10) / 10) + (c.rating ? 10 * (c.rating / 5) : 0);
    const experiencePts = 15 * (Math.min(c.yearsExperience ?? 0, 11) / 11);
    const responsePts = RESPONSE_PTS[c.responseTime] ?? 5;
    const score = Math.round((distancePts + historyPts + experiencePts + responsePts) * 10) / 10;
    const capacity = c.capacity ?? 2;
    rows.push({ ...c, distanceKm: km, score, atCapacity: (c.activeJobs ?? 0) >= capacity });
  }
  rows.sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm || a.id - b.id);
  return rows;
}
