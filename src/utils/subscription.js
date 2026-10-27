import { FEE_RULES } from './fees.js';

// The monthly subscription rules, shared by the services and by the SQL that hides vendors who have not paid.
export const SUBSCRIPTION_PERIOD_DAYS = 30;
export const SUBSCRIPTION_MONTHS = [1, 3, 6, 12];
const DAY = 24 * 60 * 60 * 1000;

export const priceFor = (vendorType, rules = FEE_RULES) => Number((vendorType === 'company' ? rules.vendorSubscriptionCompany : rules.vendorSubscriptionSeller) ?? 0);
export const isRequired = (vendorType, rules = FEE_RULES) => priceFor(vendorType, rules) > 0;

// 'not_required' | 'never' | 'active' | 'grace' | 'lapsed'. A vendor who has never paid is 'never' (not yet listed).
export function stateOf({ vendorType, paidUntil }, rules = FEE_RULES, now = new Date()) {
  if (!isRequired(vendorType, rules)) return { state: 'not_required', ok: true, paidUntil: paidUntil ?? null };
  if (!paidUntil) return { state: 'never', ok: false, paidUntil: null };
  const until = new Date(paidUntil);
  const graceEnds = new Date(until.getTime() + Number(rules.subscriptionGraceDays ?? 0) * DAY);
  if (now <= until) return { state: 'active', ok: true, paidUntil: until, daysLeft: Math.ceil((until - now) / DAY) };
  if (now <= graceEnds) return { state: 'grace', ok: true, paidUntil: until, graceEnds, daysLeft: Math.ceil((graceEnds - now) / DAY) };
  return { state: 'lapsed', ok: false, paidUntil: until, graceEnds };
}

// New paid-up date after a payment (or a gift of days): counted from today, or from the old date if that is still in the future.
export function extend(currentPaidUntil, days, now = new Date()) {
  const base = currentPaidUntil && new Date(currentPaidUntil) > now ? new Date(currentPaidUntil) : now;
  return new Date(base.getTime() + days * DAY);
}

const pad = (n) => String(n).padStart(2, '0');
const sqlDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

// A WHERE fragment for the vendor_profiles row `v`: true for vendors whose subscription (if their type needs one) is paid up
// or inside the grace period. Built from the live rules each time, so a new price or grace period applies at once.
// The date is formatted from a Date here, so nothing from a request ever reaches the SQL text.
export function subscriptionOkSql(alias = 'v', rules = FEE_RULES, now = new Date()) {
  const seller = isRequired('seller', rules);
  const company = isRequired('company', rules);
  if (!seller && !company) return '1 = 1';
  const cutoff = sqlDate(new Date(now.getTime() - Number(rules.subscriptionGraceDays ?? 0) * DAY));
  const live = `${alias}.subscription_paid_until >= '${cutoff}'`;
  return `((${alias}.vendor_type = 'company' AND ${company ? live : '1 = 1'}) OR (${alias}.vendor_type <> 'company' AND ${seller ? live : '1 = 1'}))`;
}
