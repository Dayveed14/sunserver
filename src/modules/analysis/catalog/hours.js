// People can't say "I use my TV 4.3 hours a day", but they can pick a range.
// Each range maps to a representative number of hours used in the calculation.
export const HOUR_OPTIONS = [
  { key: 'h05', label: 'Under 1 hr', hours: 0.5 },
  { key: 'h2', label: '1–2 hrs', hours: 1.5 },
  { key: 'h4', label: '3–5 hrs', hours: 4 },
  { key: 'h7', label: '6–8 hrs', hours: 7 },
  { key: 'h10', label: '9–12 hrs', hours: 10 },
  { key: 'h16', label: '13–18 hrs', hours: 15.5 },
  { key: 'h24', label: 'All day & night', hours: 24 },
];

export const HOURS_BY_KEY = new Map(HOUR_OPTIONS.map((o) => [o.key, o]));
