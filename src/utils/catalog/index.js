import { HOUR_OPTIONS } from './hours.js';
import { BUSINESS_APPLIANCES, BUSINESS_CATEGORIES, BUSINESS_PRESETS } from './business.js';
import { HOME_APPLIANCES, HOME_CATEGORIES, HOME_PRESETS } from './home.js';

// Full catalogues (with watts) stay on the server. The calculator reads these.
export const catalogs = {
  home: { categories: HOME_CATEGORIES, appliances: HOME_APPLIANCES, presets: HOME_PRESETS },
  business: { categories: BUSINESS_CATEGORIES, appliances: BUSINESS_APPLIANCES, presets: BUSINESS_PRESETS },
};

export const SUPPLY_OPTIONS = [
  { band: 'A', title: 'Almost always on', detail: '20 hours or more a day' },
  { band: 'B', title: 'Most of the day', detail: 'About 16–20 hours' },
  { band: 'C', title: 'About half the day', detail: 'About 12–16 hours' },
  { band: 'D', title: 'A few hours at a time', detail: 'About 8–12 hours' },
  { band: 'E', title: 'Very little', detail: 'Under 8 hours a day' },
  { band: null, title: 'Not sure', detail: "We'll show you every band" },
];

// What the browser needs to draw the picker. Wattage never leaves the server.
export function buildPublicCatalog(segment) {
  const catalog = catalogs[segment];
  if (!catalog) return null;
  return {
    segment,
    categories: catalog.categories,
    hourOptions: HOUR_OPTIONS.map(({ key, label }) => ({ key, label })),
    supplyOptions: SUPPLY_OPTIONS,
    presets: catalog.presets,
    appliances: catalog.appliances.map((ap) => ({
      id: ap.id,
      name: ap.name,
      category: ap.category,
      hint: ap.hint,
      hoursMode: ap.hoursMode,
      defaultHours: ap.defaultHours,
      maxQty: ap.maxQty,
      variants: ap.variants.map((vr) => ({ id: vr.id, label: vr.label, default: Boolean(vr.default) })),
    })),
  };
}
