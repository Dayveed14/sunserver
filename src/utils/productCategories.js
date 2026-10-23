// Every kind of product a vendor can list, in one place. The database column (products.category), the checks on
// vendor/admin forms, the shop filter and the client's product form all follow this list.
// (The browser has its own copy in client/src/lib/productCategories.js: keep the two in step.)
//
// CORE products (panel, inverter, battery) are what the energy assessment sizes, what the "build your own" screen
// offers and what vendor deals are made from. Every other product is sold from the shop only.
//
// rating: the main size of the product, stored in products.rating.
//   required = vendor must give it, optional = may be left empty, none = not asked (stored as 0)
// voltage: the battery voltage it works with (12, 24 or 48): required, optional or none.

export const CORE_CATEGORIES = ['panel', 'inverter', 'battery'];

export const CATEGORY_GROUPS = ['Core system', 'Power & control', 'Mounting & wiring', 'Protection & safety', 'Monitoring & metering', 'Complete products'];

const size = (mode, label, unit, min, max, integer = false) => ({ mode, label, unit, min, max, integer });
const NO_SIZE = { mode: 'none' };

export const CATEGORY_SPECS = {
  panel: { label: 'Solar panel', plural: 'Solar panels', group: 'Core system', rating: size('required', 'Power per panel (watts)', 'W', 50, 1000, true), voltage: 'none' },
  inverter: { label: 'Inverter', plural: 'Inverters', group: 'Core system', rating: size('required', 'Inverter size (kVA)', 'kVA', 0.3, 50), voltage: 'required' },
  battery: { label: 'Battery', plural: 'Batteries', group: 'Core system', rating: size('required', 'Usable storage per unit (kWh)', 'kWh', 0.5, 200), voltage: 'required' },

  controller: { label: 'Charge controller', plural: 'Charge controllers', group: 'Power & control', rating: size('required', 'Rated charging current (A)', 'A', 1, 200, true), voltage: 'optional' },
  portable_power: { label: 'Portable power station', plural: 'Portable power stations', group: 'Power & control', rating: size('required', 'Usable storage (kWh)', 'kWh', 0.1, 50), voltage: 'optional' },
  generator: { label: 'Generator', plural: 'Generators', group: 'Power & control', rating: size('required', 'Output (kVA)', 'kVA', 0.5, 2000), voltage: 'none' },
  transfer_switch: { label: 'Transfer switch', plural: 'Transfer switches', group: 'Power & control', rating: size('optional', 'Rated current (A)', 'A', 1, 1000, true), voltage: 'none' },
  energy_management: { label: 'Energy management', plural: 'Energy management', group: 'Power & control', rating: NO_SIZE, voltage: 'none' },

  mounting: { label: 'Mounting & racking', plural: 'Mounting & racking', group: 'Mounting & wiring', rating: NO_SIZE, voltage: 'none' },
  cable: { label: 'Solar cable', plural: 'Solar cables', group: 'Mounting & wiring', rating: NO_SIZE, voltage: 'none' },
  connector: { label: 'Connector', plural: 'Connectors', group: 'Mounting & wiring', rating: NO_SIZE, voltage: 'none' },
  distribution: { label: 'Combiner / distribution box', plural: 'Combiner & distribution boxes', group: 'Mounting & wiring', rating: NO_SIZE, voltage: 'none' },

  protection: { label: 'Breaker / fuse', plural: 'Breakers & fuses', group: 'Protection & safety', rating: size('optional', 'Rated current (A)', 'A', 1, 1000, true), voltage: 'none' },
  surge_protection: { label: 'Surge protection', plural: 'Surge protection', group: 'Protection & safety', rating: NO_SIZE, voltage: 'none' },
  earthing: { label: 'Earthing & lightning', plural: 'Earthing & lightning', group: 'Protection & safety', rating: NO_SIZE, voltage: 'none' },

  meter: { label: 'Energy meter', plural: 'Energy meters', group: 'Monitoring & metering', rating: NO_SIZE, voltage: 'none' },
  monitoring: { label: 'Monitoring device', plural: 'Monitoring devices', group: 'Monitoring & metering', rating: NO_SIZE, voltage: 'none' },

  pump: { label: 'Solar pump', plural: 'Solar pumps', group: 'Complete products', rating: size('required', 'Pump power (watts)', 'W', 50, 50000, true), voltage: 'none' },
  streetlight: { label: 'Solar streetlight', plural: 'Solar streetlights', group: 'Complete products', rating: size('required', 'Light power (watts)', 'W', 5, 500, true), voltage: 'none' },
  lighting: { label: 'Solar lighting', plural: 'Solar lighting', group: 'Complete products', rating: size('required', 'Light power (watts)', 'W', 1, 1000, true), voltage: 'none' },
  kit: { label: 'Solar kit', plural: 'Solar kits', group: 'Complete products', rating: size('required', 'System size (kWp)', 'kWp', 0.05, 1000), voltage: 'none' },
  accessory: { label: 'Accessory', plural: 'Accessories', group: 'Complete products', rating: NO_SIZE, voltage: 'none' },
};

// The order matches the database ENUM (new values are only ever added at the end).
export const PRODUCT_CATEGORIES = [
  'panel', 'inverter', 'battery', 'controller', 'mounting', 'cable', 'connector', 'protection', 'surge_protection',
  'distribution', 'earthing', 'accessory', 'meter', 'monitoring', 'transfer_switch', 'energy_management',
  'portable_power', 'generator', 'pump', 'streetlight', 'lighting', 'kit',
];

export const isCategory = (value) => Object.hasOwn(CATEGORY_SPECS, value);
export const isCore = (value) => CORE_CATEGORIES.includes(value);
