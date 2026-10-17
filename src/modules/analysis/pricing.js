// Every number the cost estimates depend on lives here, in one place.
//
// IMPORTANT: these are indicative defaults, not live data.
//  - fuelPricePerLitre was supplied by the product owner (Oct 2026). Confirm it against the current pump price.
//  - Band tariffs below are approximate AEDC figures from public sources and are applied to every DisCo.
//    Published sources disagree on the current Band A rate (N206.80 to N225 per kWh), so check the latest
//    NERC order for each DisCo before launch and update `tariffs`.
//  - Solar and financing prices are placeholders until real vendor quotes flow in from the marketplace.
//
// Phase 1b: move this into an admin-editable table so no code change is needed.

export const ASSUMPTIONS = {
  asOf: '2026-10-16',

  fuelPricePerLitre: 1550,
  generator: {
    home: { fuel: 'petrol', litresPerKwh: 0.75 }, // small "I better pass my neighbour" generators
    business: { fuel: 'diesel', litresPerKwh: 0.42 }, // larger diesel sets run more efficiently
    maintenancePct: 0.12, // oil, servicing and repairs as a share of fuel cost
  },

  // NERC supply bands. We use the middle of each band's hours, because "20+" really means 20 to 24.
  bands: {
    A: { typicalHours: 22, label: '20+ hrs' },
    B: { typicalHours: 18, label: '16–20 hrs' },
    C: { typicalHours: 14, label: '12–16 hrs' },
    D: { typicalHours: 10, label: '8–12 hrs' },
    E: { typicalHours: 6, label: '4–8 hrs' },
  },

  tariffsVerified: false,
  tariffs: {
    default: { A: 209.5, B: 63.35, C: 51.79, D: 33.95, E: 28.0 }, // N per kWh
  },

  // peakSunHours = average full-sun hours per day for the DisCo's main region (approximate).
  discos: [
    { id: 'aedc', name: 'AEDC (Abuja, Niger, Nasarawa, Kogi)', peakSunHours: 5.4 },
    { id: 'ikedc', name: 'Ikeja Electric (Lagos mainland)', peakSunHours: 4.6 },
    { id: 'ekedc', name: 'Eko Electricity (Lagos island)', peakSunHours: 4.6 },
    { id: 'ibedc', name: 'IBEDC (Ibadan, Oyo, Ogun, Osun, Kwara)', peakSunHours: 4.8 },
    { id: 'eedc', name: 'EEDC (Enugu and the South-East)', peakSunHours: 4.6 },
    { id: 'phedc', name: 'PHED (Port Harcourt, Rivers, Bayelsa)', peakSunHours: 4.2 },
    { id: 'bedc', name: 'BEDC (Benin, Edo, Delta, Ondo)', peakSunHours: 4.4 },
    { id: 'jed', name: 'Jos Electricity (Plateau, Bauchi, Benue, Gombe)', peakSunHours: 5.6 },
    { id: 'kaedco', name: 'Kaduna Electric (Kaduna, Kebbi, Sokoto, Zamfara)', peakSunHours: 5.7 },
    { id: 'kedco', name: 'Kano Electricity (Kano, Katsina, Jigawa)', peakSunHours: 5.8 },
    { id: 'yedc', name: 'Yola Electricity (Adamawa, Taraba, Borno, Yobe)', peakSunHours: 5.7 },
    { id: 'abapower', name: 'Aba Power (Aba, Abia)', peakSunHours: 4.4 },
  ],

  // Rough installed prices (N). Replace with vendor quotes once the marketplace is live.
  solar: {
    performanceRatio: 0.75, // real-world losses: dust, heat, wiring
    panelWatts: 550,
    pvCostPerKwp: 350_000,
    inverterCostPerKva: 180_000,
    batteryCostPerKwh: 380_000, // lithium
    batteryDepthOfDischarge: 0.8,
    batteryRoundTrip: 0.9,
    installPct: 0.12, // mounting, cabling, protection and labour
    annualMaintenancePct: 0.01,
  },

  financing: {
    lease: { termMonths: 36, markupPct: 0.25, depositPct: 0.15 }, // you own it at the end
    rent: { monthlyPct: 0.035 }, // of system cost per month; maintenance included, cancel any time
    // Pay monthly, provider owns and runs it. Priced by marketplace/eaas.js; installation is spread over the monthly
    // payments here so the card can honestly say "no upfront payment". Vendors may offer paying it upfront for less.
    eaas: { termMonths: 60, installationMode: 'rolled' },
  },

  sizing: {
    diversity: { home: 0.6, business: 0.7 }, // not everything runs at the same moment
    inverterHeadroom: 1.2,
    powerFactor: 0.8,
    siteAuditKw: 30, // above this connected load we recommend a proper site survey
  },
};
