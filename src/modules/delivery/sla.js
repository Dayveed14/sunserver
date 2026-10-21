// How long an order should take, and what we promise the customer.
//
// An order moves through: vendor accepts it, vendor prepares it (while a rider is on the way), rider collects it,
// rider travels to the customer. We add up each leg, count only working hours, slow the travel down in rush hour,
// then add a cushion for the things that go wrong, so that promises are kept more often than not.
// Every number is a placeholder to tune against real delivery data. Times are Lagos time (UTC+1, no daylight saving).

export const SLA_RULES = {
  openHour: 8, // vendors and riders start at 08:00
  closeHour: 18, // vendors stop taking and preparing orders at 18:00
  lastDeliveryHour: 19, // riders deliver until 19:00
  sundayClosed: 1, // 1 = nothing moves on Sundays
  acceptMinutes: 30, // time we allow a vendor to accept
  prepBaseMinutes: 60, // preparing and packing one item
  prepPerExtraLineMinutes: 10, // each further kind of item
  riderArrivalMinutes: 30, // rider is sent as soon as the vendor accepts, so this overlaps with preparation
  handoverMinutes: 10, // loading, checking, handing over at the door
  speedKph: { Central: 18, Inner: 22, Outer: 30 }, // average road speed by where the customer is
  rushHourMultiplier: 1.5, // travel takes longer 07:00-10:00 and 16:00-19:30 on weekdays
  bufferPct: 0.2, // cushion on top for delays and inefficiency
  bufferFixedMinutes: 15,
  roundToMinutes: 15, // promises are rounded up to a quarter of an hour
  autoReceiveHours: 12, // delivered orders count as received after this long
};

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const LAGOS_OFFSET = HOUR;

const local = (ms) => new Date(ms + LAGOS_OFFSET); // read with getUTC* methods to get Lagos clock values
const minutesOfDay = (ms) => {
  const d = local(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const dayOf = (ms) => local(ms).getUTCDay(); // 0 = Sunday
const startOfLocalDay = (ms) => {
  const d = local(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - LAGOS_OFFSET;
};
const isClosedDay = (ms, rules) => (rules.sundayClosed && dayOf(ms) === 0);

// The first moment at or after `ms` when work can happen.
export function nextOpen(ms, closeHour, rules = SLA_RULES) {
  let t = ms;
  for (let i = 0; i < 10; i++) {
    const day0 = startOfLocalDay(t);
    if (isClosedDay(t, rules)) { t = day0 + 24 * HOUR + rules.openHour * HOUR; continue; }
    const m = minutesOfDay(t);
    if (m < rules.openHour * 60) return day0 + rules.openHour * HOUR;
    if (m >= closeHour * 60) { t = day0 + 24 * HOUR + rules.openHour * HOUR; continue; }
    return t;
  }
  return t;
}

// Adds working minutes, skipping nights, closing time and Sundays.
export function addWorkingMinutes(ms, minutes, closeHour, rules = SLA_RULES) {
  let t = nextOpen(ms, closeHour, rules);
  let left = minutes;
  while (left > 0) {
    const room = closeHour * 60 - minutesOfDay(t);
    if (left <= room) return t + left * MIN;
    left -= room;
    t = nextOpen(startOfLocalDay(t) + 24 * HOUR, closeHour, rules);
  }
  return t;
}

const isRushHour = (ms) => {
  const day = dayOf(ms);
  if (day === 0 || day === 6) return false;
  const m = minutesOfDay(ms);
  return (m >= 7 * 60 && m < 10 * 60) || (m >= 16 * 60 && m < 19 * 60 + 30);
};

const ceilTo = (ms, mins) => Math.ceil(ms / (mins * MIN)) * mins * MIN;

// Works out when an order will arrive. `zone` is Central, Inner or Outer for the customer's area.
export function estimateDelivery({ placedAt, distanceKm, zone = 'Inner', lines = 1 }, rules = SLA_RULES) {
  const placed = new Date(placedAt).getTime();
  const afterHours = nextOpen(placed, rules.closeHour, rules) !== placed;

  // 1. The vendor sees the order when they open (or straight away if they are open) and accepts it.
  const acceptedAt = addWorkingMinutes(placed, rules.acceptMinutes, rules.closeHour, rules);

  // 2. Preparation and the rider's journey to the vendor happen at the same time; the slower one sets pickup.
  const prep = rules.prepBaseMinutes + Math.max(0, lines - 1) * rules.prepPerExtraLineMinutes;
  const pickupWait = Math.max(prep, rules.riderArrivalMinutes);
  const pickedUpAt = addWorkingMinutes(acceptedAt, pickupWait, rules.closeHour, rules);

  // 3. The ride. Slower in rush hour. Riders work to a later closing time than vendors.
  const speed = rules.speedKph[zone] ?? rules.speedKph.Inner;
  const travel = Math.ceil(((distanceKm / speed) * 60 * (isRushHour(pickedUpAt) ? rules.rushHourMultiplier : 1)) + rules.handoverMinutes);
  const earliest = addWorkingMinutes(pickedUpAt, travel, rules.lastDeliveryHour, rules);

  // 4. The cushion: what we promise is later than what we expect, because some orders always go wrong.
  const workMinutes = pickupWait + travel;
  const cushion = Math.ceil(workMinutes * rules.bufferPct) + rules.bufferFixedMinutes;
  const promisedBy = ceilTo(addWorkingMinutes(earliest, cushion, rules.lastDeliveryHour, rules), rules.roundToMinutes);

  return {
    placedAt: new Date(placed).toISOString(),
    acceptBy: new Date(acceptedAt).toISOString(),
    expectedAt: new Date(ceilTo(earliest, rules.roundToMinutes)).toISOString(),
    promisedBy: new Date(promisedBy).toISOString(),
    afterHours,
    steps: { acceptMinutes: rules.acceptMinutes, prepMinutes: pickupWait, travelMinutes: travel, cushionMinutes: cushion },
  };
}

// "Today, 2:15 PM", "Tomorrow, 9:30 AM", or "Wed 22 Oct, 11:00 AM", in Lagos time.
export function formatLagos(iso, now = new Date()) {
  const ms = new Date(iso).getTime();
  const d = local(ms);
  const h = d.getUTCHours();
  const clock = `${((h + 11) % 12) + 1}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  const dayDiff = Math.round((startOfLocalDay(ms) - startOfLocalDay(now.getTime())) / (24 * HOUR));
  if (dayDiff === 0) return `Today, ${clock}`;
  if (dayDiff === 1) return `Tomorrow, ${clock}`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${clock}`;
}

// Several vendors: the customer is promised the last of them.
export const latestOf = (estimates) =>
  estimates.reduce((worst, e) => (!worst || new Date(e.promisedBy) > new Date(worst.promisedBy) ? e : worst), null);

export const autoReceiveAt = (deliveredAt, rules = SLA_RULES) => new Date(new Date(deliveredAt).getTime() + rules.autoReceiveHours * HOUR);
