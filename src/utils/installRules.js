// What an installation costs, by the size of the system, and what the installer earns. The admin edits the prices
// (Pricing & rules → Installation). The size limits are fixed here so every price has a clear place to sit.
export const INSTALL_BANDS = [
  { id: 'b1', label: 'Up to 1 kW', maxKw: 1 },
  { id: 'b2', label: 'Over 1 kW to 3 kW', maxKw: 3 },
  { id: 'b3', label: 'Over 3 kW to 5 kW', maxKw: 5 },
  { id: 'b4', label: 'Over 5 kW to 10 kW', maxKw: 10 },
  { id: 'b5', label: 'Over 10 kW to 20 kW', maxKw: 20 },
  { id: 'b6', label: 'Over 20 kW to 50 kW', maxKw: 50 },
];
export const MAX_INSTALL_KW = INSTALL_BANDS.at(-1).maxKw;

export const INSTALL_RULES = {
  prices: { b1: 35000, b2: 65000, b3: 110000, b4: 200000, b5: 350000, b6: 700000 }, // naira charged to the customer
  payoutPct: 0.7, // share of the fee the installer earns
  alertMinutes: 120, // nobody accepted after this long: the admin is alerted
  autoCloseHours: 12, // the customer did not confirm: the job closes by itself after this long
};

export function bandFor(kw, rules = INSTALL_RULES) {
  const n = Number(kw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_INSTALL_KW) return null;
  const band = INSTALL_BANDS.find((b) => n <= b.maxKw);
  return { ...band, price: rules.prices[band.id] };
}

// The quote for a system of this size: what the customer pays and what the installer earns.
export function installQuote(kw, rules = INSTALL_RULES) {
  const band = bandFor(kw, rules);
  if (!band) return null;
  const payout = Math.round(band.price * rules.payoutPct);
  return { bandId: band.id, bandLabel: band.label, price: band.price, installerPayout: payout, platformShare: band.price - payout };
}
