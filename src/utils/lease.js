// Lease to own, "pay small small": the customer pays a deposit, then spreads the rest over 3, 4, 6 or 12 months and
// owns the system at the end. The longer the plan, the more it costs in total, because the vendor waits longer to be paid.
// Numbers are placeholders; an admin can change them under Pricing & rules.
export const LEASE_RULES = {
  tenors: [3, 4, 6, 12],
  // Extra charged on top of the cash price for each plan length.
  markupPct: { 3: 0.08, 4: 0.1, 6: 0.15, 12: 0.25 },
  // The share of the cash price paid up front. Vendors choose inside these limits.
  depositPct: { min: 0.1, max: 0.6, default: 0.3 },
};

const roundUp100 = (n) => Math.ceil(n / 100) * 100;

// What one plan length costs for a system with this cash price.
export function priceLease(buyPrice, { depositPct, months }, rules = LEASE_RULES) {
  const markup = rules.markupPct[months];
  if (markup === undefined) return null;
  const deposit = Math.round((buyPrice * depositPct) / 100) * 100;
  const total = buyPrice * (1 + markup);
  const monthly = roundUp100((total - deposit) / months);
  return { months, deposit, monthly, totalPayable: deposit + monthly * months, extra: deposit + monthly * months - buyPrice };
}

// Every plan length the vendor offers, shortest first.
export function leaseOptions(buyPrice, { depositPct, tenors }, rules = LEASE_RULES) {
  return [...tenors]
    .sort((a, b) => a - b)
    .map((months) => priceLease(buyPrice, { depositPct, months }, rules))
    .filter(Boolean);
}

export function validateLeaseTerms({ depositPct, tenors }, rules = LEASE_RULES) {
  const errors = {};
  if (!Array.isArray(tenors) || tenors.length === 0) errors.tenors = 'Choose at least one payment plan.';
  else if (tenors.some((m) => !rules.tenors.includes(m))) errors.tenors = 'Plans can be 3, 4, 6 or 12 months.';
  if (!(depositPct >= rules.depositPct.min && depositPct <= rules.depositPct.max)) {
    errors.depositPct = `Deposit must be between ${Math.round(rules.depositPct.min * 100)}% and ${Math.round(rules.depositPct.max * 100)}%.`;
  }
  return errors;
}
