// "What matters most to you?" The customer ticks priorities; each one points at real items in the catalogue,
// so a priority always changes the numbers (which items count as critical in a power cut, and what is kept in a smaller system).
// `reduce_fuel` is different: it names no items. It tells us to size for the whole site and to show the fuel saved.

const set = (...ids) => new Set(ids);

export const PRIORITIES = [
  { id: 'food', label: 'Keep food and drinks cold', hint: 'Fridges, freezers and drink coolers.',
    ids: set('fridge', 'freezer', 'water-dispenser', 'b-fridge', 'b-dispenser', 'w-chiller') },
  { id: 'ac', label: 'Run air conditioning', hint: 'This is usually the biggest cost in a system.',
    ids: set('ac', 'air-cooler', 'b-ac', 'b-central-ac'), notEssential: true },
  { id: 'lights_fans', label: 'Keep lights and fans on', hint: 'Bulbs, tubes, ceiling and standing fans.',
    ids: set('led-bulb', 'cfl-bulb', 'old-bulb', 'tube-light', 'security-light', 'ceiling-fan', 'standing-fan', 'table-fan',
      'b-led-light', 'b-old-light', 'b-outdoor-light', 'b-fan', 'b-vent', 'w-chandelier', 'w-track-light') },
  { id: 'computers', label: 'Power computers and internet', hint: 'Laptops, desktops, routers, phones and printers.',
    ids: set('laptop', 'desktop', 'phone', 'printer', 'internet', 'b-desktop', 'b-laptop', 'b-monitor', 'b-printer', 'b-copier', 'b-network', 'b-wifi') },
  { id: 'business_ops', label: 'Keep business operations running', hint: 'Tills, POS, signs, computers and the network.',
    ids: set('b-pos', 'b-cash-counter', 'b-atm', 'b-display', 'b-signage', 'b-desktop', 'b-laptop', 'b-monitor', 'b-network', 'b-wifi', 'b-printer'),
    categories: set('Banking & retail') },
  { id: 'medical', label: 'Power essential medical equipment', hint: 'Oxygen machines, CPAP and clinic or lab equipment.',
    ids: set('oxygen-concentrator', 'cpap', 'fridge', 'b-fridge', 'w-incubator', 'w-centrifuge', 'w-hematocrit', 'w-microscope', 'w-electrophoresis', 'w-uv', 'w-chiller'),
    uninterrupted: true },
  { id: 'machines', label: 'Run machines or production equipment', hint: 'Motors, compressors, welders, sewing and workshop tools.',
    ids: set('water-pump', 'sewing', 'b-pump', 'b-motor', 'b-compressor', 'b-welding', 'w-sewing', 'w-coiler', 'w-soldering', 'w-laminator', 'w-plotter', 'w-shirt-cutter'),
    categories: set('Heavy equipment'), notEssential: true },
  { id: 'reduce_fuel', label: 'Reduce generator and fuel use', hint: 'We size for the whole site so the generator mostly rests.', wholeSite: true },
  { id: 'security', label: 'Keep security systems running', hint: 'CCTV, gate, access control and security lights.',
    ids: set('cctv', 'security-light', 'gate-motor', 'b-cctv', 'b-access', 'b-gate', 'b-outdoor-light') },
];

export const PRIORITY_BY_ID = new Map(PRIORITIES.map((p) => [p.id, p]));
export const PRIORITY_IDS = PRIORITIES.map((p) => p.id);

// Does this priority cover the item?
export const priorityCovers = (priority, appliance) =>
  Boolean(priority?.ids?.has(appliance.id) || priority?.categories?.has(appliance.category));

// What the browser needs: which catalogue items each priority points at, for this segment.
export function publicPriorities(catalog) {
  return PRIORITIES.map((p) => ({
    id: p.id,
    label: p.label,
    hint: p.hint,
    wholeSite: Boolean(p.wholeSite),
    notEssential: Boolean(p.notEssential),
    applianceIds: catalog.appliances.filter((ap) => priorityCovers(p, ap)).map((ap) => ap.id),
  })).filter((p) => p.wholeSite || p.applianceIds.length > 0);
}

// With no priority picked and nothing marked, these keep a home or shop going.
export const DEFAULT_CRITICAL_PRIORITIES = ['food', 'lights_fans', 'computers'];
