import { SURVEY_APPLIANCES, SURVEY_CATEGORY, SURVEY_EXTRA_VARIANTS } from './fieldSurvey.js';
import { appliance as a, v } from './helpers.js';

const BASE_CATEGORIES = [
  'Cooling & lighting',
  'Computers & office',
  'Banking & retail',
  'Kitchen & breakroom',
  'Building services',
  'Security',
  'Heavy equipment',
];

// The field-survey categories sit before 'Heavy equipment' so the picker stays in a sensible order.
export const BUSINESS_CATEGORIES = [...BASE_CATEGORIES.slice(0, -1), SURVEY_CATEGORY, BASE_CATEGORIES.at(-1)];

const OFFICE = { defaultHours: 'h10', daytimeShare: 0.9 };

const BASE_APPLIANCES = [
  // ---------- Cooling & lighting ----------
  a('b-ac', 'Air conditioners', 'Cooling & lighting', 'Pick the horsepower (HP) on the unit. Tap + for each type you have.',
    { ...OFFICE, dutyCycle: 0.7, surge: 3, maxQty: 300 },
    [
      v('1hp', '1 HP split', 850),
      v('1.5hp', '1.5 HP split', 1300),
      v('2hp', '2 HP split', 1800, { default: true }),
      v('2.5hp', '2.5–3 HP split / standing', 2400),
      v('cassette-3', 'Cassette / ceiling type (3 HP)', 2800),
      v('cassette-5', 'Cassette / ceiling type (5 HP)', 4500),
      v('inv-1.5', '1.5 HP inverter AC', 900, { surge: 1.5 }),
      v('inv-2', '2 HP inverter AC', 1250, { surge: 1.5 }),
      v('window', 'Window unit', 1100),
    ]),
  a('b-central-ac', 'Central air conditioning (chiller / VRF)', 'Cooling & lighting', 'For buildings cooled by a central plant. Tons of cooling are on the plant plate.',
    { ...OFFICE, dutyCycle: 0.7, surge: 2, maxQty: 20 },
    [v('10tr', 'About 10 tons of cooling', 11000, { default: true }), v('20tr', 'About 20 tons', 22000), v('40tr', 'About 40 tons', 44000)]),
  a('b-led-light', 'LED lights', 'Cooling & lighting', 'Panels, bulbs and downlights.',
    { ...OFFICE, daytimeShare: 0.85, maxQty: 2000 },
    [v('panel', 'LED panel (40W)', 40, { default: true }), v('bulb', 'LED bulb (10W)', 10), v('downlight', 'Spotlight / downlight (7W)', 7), v('tube', 'LED tube (18W)', 18)]),
  a('b-old-light', 'Older fluorescent lights', 'Cooling & lighting', 'Tube lights and energy-saving bulbs.',
    { ...OFFICE, daytimeShare: 0.85, maxQty: 2000 },
    [v('tube', 'Tube light with ballast (45W)', 45, { default: true }), v('cfl', 'Energy-saving bulb (20W)', 20)]),
  a('b-outdoor-light', 'Security / outdoor lighting', 'Cooling & lighting', 'Floodlights that stay on at night.',
    { defaultHours: 'h10', daytimeShare: 0, maxQty: 200 },
    [v('50', 'LED floodlight 50W', 50, { default: true }), v('100', 'LED floodlight 100W', 100), v('200', 'LED floodlight 200W', 200)]),
  a('b-fan', 'Fans', 'Cooling & lighting', 'Ceiling, standing and wall fans.',
    { ...OFFICE, surge: 1.5, maxQty: 300 },
    [v('ceiling', 'Ceiling fan', 70, { default: true }), v('standing', 'Standing fan', 60), v('wall', 'Wall fan', 55)]),

  // ---------- Computers & office ----------
  a('b-desktop', 'Desktop computers', 'Computers & office', 'Computer plus its screen.',
    { ...OFFICE, daytimeShare: 0.95, maxQty: 1000 },
    [v('standard', 'Desktop + monitor', 180, { default: true }), v('mini', 'Mini PC + monitor', 70), v('workstation', 'High-performance workstation', 350)]),
  a('b-laptop', 'Laptops (plugged in)', 'Computers & office', 'Laptops charging at desks.',
    { ...OFFICE, daytimeShare: 0.95, maxQty: 1000 },
    [v('standard', 'Standard laptop', 60, { default: true })]),
  a('b-monitor', 'Extra monitors / screens', 'Computers & office', 'Second screens at desks.',
    { ...OFFICE, daytimeShare: 0.95, maxQty: 1000 },
    [v('22', '22–24 inch', 25, { default: true }), v('27', '27 inch', 35)]),
  a('b-printer', 'Printers', 'Computers & office', 'Counted at their typical working use, not just printing time.',
    { ...OFFICE, dutyCycle: 0.3, daytimeShare: 0.95, maxQty: 200 },
    [v('inkjet', 'Inkjet', 50), v('laser', 'Desktop laser', 400, { default: true }), v('laser-office', 'Heavy-use office laser', 700)]),
  a('b-copier', 'Photocopiers / multifunction machines', 'Computers & office', 'Copiers and scanners.',
    { ...OFFICE, dutyCycle: 0.3, surge: 2, daytimeShare: 0.95, maxQty: 100 },
    [v('desktop', 'Desktop multifunction', 600), v('floor', 'Floor-standing copier', 1500, { default: true }), v('highvol', 'High-volume copier', 2200)]),
  a('b-network', 'Server / network equipment', 'Computers & office', 'Runs all day and night.',
    { hoursMode: 'fixed', daytimeShare: 0.5, maxQty: 50 },
    [v('rack', 'Small network rack (router + switch)', 150, { default: true }), v('server', 'One server + switch', 450), v('server-room', 'Server room (several servers)', 2000)]),
  a('b-wifi', 'Wi-Fi routers / access points', 'Computers & office', 'Runs all day and night.',
    { hoursMode: 'fixed', daytimeShare: 0.5, maxQty: 200 },
    [v('ap', 'Router / access point', 15, { default: true })]),

  // ---------- Banking & retail ----------
  a('b-atm', 'ATMs', 'Banking & retail', 'Runs all day and night. The ATM room AC is counted under Air conditioners.',
    { hoursMode: 'fixed', daytimeShare: 0.5, surge: 1.5, maxQty: 100 },
    [v('standard', 'Standard ATM', 700, { default: true }), v('recycler', 'Cash-deposit / recycler ATM', 900)]),
  a('b-cash-counter', 'Cash counting / note sorting', 'Banking & retail', 'Counting machines on teller counters.',
    { defaultHours: 'h4', daytimeShare: 0.95, maxQty: 200 },
    [v('counter', 'Note counting machine', 60, { default: true }), v('sorter', 'Note sorting machine', 150)]),
  a('b-pos', 'POS terminals / card readers', 'Banking & retail', 'Point-of-sale devices.',
    { ...OFFICE, daytimeShare: 0.95, maxQty: 500 },
    [v('pos', 'POS terminal', 10, { default: true })]),
  a('b-display', 'TVs / display screens', 'Banking & retail', 'Waiting-area and queue screens.',
    { ...OFFICE, maxQty: 200 },
    [v('43', '43 inch', 65, { default: true }), v('55', '55 inch', 120), v('65', '65 inch and above', 170)]),
  a('b-signage', 'Signage / lightboxes', 'Banking & retail', 'Branded signs and digital boards.',
    { defaultHours: 'h10', daytimeShare: 0.2, maxQty: 100 },
    [v('sign', 'LED signboard / lightbox', 80, { default: true }), v('screen', 'Large LED display', 400)]),

  // ---------- Kitchen & breakroom ----------
  a('b-fridge', 'Refrigerators & freezers', 'Kitchen & breakroom', 'Runs all day and night.',
    { hoursMode: 'fixed', dutyCycle: 0.45, surge: 4, daytimeShare: 0.5, maxQty: 100 },
    [v('single', 'Single-door fridge', 120, { default: true }), v('double', 'Double-door fridge', 200), v('display', 'Display / showcase fridge', 350), v('chest', 'Chest freezer (medium)', 200)]),
  a('b-dispenser', 'Water dispensers', 'Kitchen & breakroom', 'Most are left on all day.',
    { hoursMode: 'fixed', dutyCycle: 0.35, daytimeShare: 0.5, maxQty: 100 },
    [v('hot-cold', 'Hot & cold', 500, { default: true }), v('cold', 'Cold / normal only', 150)]),
  a('b-microwave', 'Microwaves', 'Kitchen & breakroom', 'Staff kitchen or canteen.',
    { defaultHours: 'h2', daytimeShare: 0.95, maxQty: 50 },
    [v('standard', 'Standard (25–30L)', 1400, { default: true }), v('large', 'Commercial / large', 1800)]),
  a('b-kettle', 'Electric kettles', 'Kitchen & breakroom', 'For hot drinks.',
    { defaultHours: 'h05', daytimeShare: 0.95, maxQty: 50 },
    [v('kettle', 'Electric kettle', 1800, { default: true })]),
  a('b-coffee', 'Coffee machines', 'Kitchen & breakroom', 'Office and commercial machines.',
    { defaultHours: 'h7', dutyCycle: 0.4, daytimeShare: 0.95, maxQty: 50 },
    [v('small', 'Small office machine', 1000), v('office', 'Office bean-to-cup', 1500, { default: true }), v('commercial', 'Commercial machine', 2500)]),

  // ---------- Building services ----------
  a('b-pump', 'Water pump / booster', 'Building services', 'Borehole and tank pumps. HP is written on the pump.',
    { defaultHours: 'h2', surge: 3, daytimeShare: 0.8, maxQty: 20 },
    [v('half', '0.5 HP', 400), v('one', '1 HP', 750, { default: true }), v('two', '2 HP', 1500), v('three', '3 HP', 2200)]),
  a('b-lift', 'Lifts / elevators', 'Building services', 'Passenger lifts.',
    { ...OFFICE, dutyCycle: 0.2, surge: 2.5, maxQty: 20 },
    [v('small', 'Small passenger lift (4–6 people)', 7500, { default: true }), v('large', 'Large lift (8–13 people)', 11000)]),
  a('b-vent', 'Extractor / ventilation fans', 'Building services', 'Kitchen extractors and building ventilation.',
    { ...OFFICE, maxQty: 100 },
    [v('small', 'Small extractor', 80, { default: true }), v('large', 'Large ventilation fan', 400)]),

  // ---------- Security ----------
  a('b-cctv', 'CCTV systems', 'Security', 'Cameras and recorders. Runs all day and night.',
    { hoursMode: 'fixed', daytimeShare: 0.5, maxQty: 50 },
    [v('8', '8 cameras + recorder', 80, { default: true }), v('16', '16 cameras + recorder', 160), v('32', '32+ cameras + recorder', 320)]),
  a('b-access', 'Access control & alarms', 'Security', 'Door controllers, biometrics, alarm panels.',
    { hoursMode: 'fixed', daytimeShare: 0.5, maxQty: 100 },
    [v('access', 'Access control / alarm panel', 40, { default: true }), v('biometric', 'Biometric / smart locks (set)', 60)]),
  a('b-gate', 'Gate / boom barrier motors', 'Security', 'Car park and compound gates.',
    { defaultHours: 'h05', surge: 3, daytimeShare: 0.8, maxQty: 20 },
    [v('gate', 'Gate / boom barrier motor', 300, { default: true })]),

  // ---------- Heavy equipment ----------
  a('b-motor', 'Industrial motors / machines', 'Heavy equipment', 'Production machines and large motors. kW or HP is on the plate.',
    { defaultHours: 'h7', dutyCycle: 0.7, surge: 4, daytimeShare: 0.9, maxQty: 100 },
    [v('small', 'Small (about 3 kW / 4 HP)', 3000, { default: true }), v('medium', 'Medium (about 7.5 kW / 10 HP)', 7500), v('large', 'Large (about 15 kW / 20 HP)', 15000)]),
  a('b-compressor', 'Air compressors', 'Heavy equipment', 'Workshop and plant compressors.',
    { defaultHours: 'h7', dutyCycle: 0.5, surge: 4, daytimeShare: 0.9, maxQty: 50 },
    [v('small', 'Small (2–3 HP)', 2200, { default: true }), v('large', 'Large (7.5–10 HP)', 7500)]),
  a('b-welding', 'Welding machines', 'Heavy equipment', 'Arc and MIG welders.',
    { defaultHours: 'h4', dutyCycle: 0.4, surge: 1.5, daytimeShare: 0.95, maxQty: 50 },
    [v('small', 'Small (about 200A)', 5000, { default: true }), v('large', 'Large (about 400A)', 12000)]),
];

// Base catalogue + the extra sizes and new devices from the field survey (see fieldSurvey.js).
export const BUSINESS_APPLIANCES = [
  ...BASE_APPLIANCES.map((ap) => (SURVEY_EXTRA_VARIANTS[ap.id] ? { ...ap, variants: [...ap.variants, ...SURVEY_EXTRA_VARIANTS[ap.id]] } : ap)),
  ...SURVEY_APPLIANCES,
];

export const BUSINESS_PRESETS = [
  {
    id: 'shop',
    label: 'Small shop or office',
    items: [
      { applianceId: 'b-led-light', variantId: 'panel', qty: 8 },
      { applianceId: 'b-ac', variantId: '1.5hp', qty: 2 },
      { applianceId: 'b-desktop', variantId: 'standard', qty: 3 },
      { applianceId: 'b-printer', variantId: 'laser', qty: 1 },
      { applianceId: 'b-fridge', variantId: 'display', qty: 1 },
      { applianceId: 'b-fan', variantId: 'ceiling', qty: 2 },
      { applianceId: 'b-wifi', variantId: 'ap', qty: 1 },
      { applianceId: 'b-cctv', variantId: '8', qty: 1 },
      { applianceId: 'b-pos', variantId: 'pos', qty: 1 },
    ],
  },
  {
    id: 'branch',
    label: 'Bank branch',
    items: [
      { applianceId: 'b-led-light', variantId: 'panel', qty: 60 },
      { applianceId: 'b-ac', variantId: '2hp', qty: 10 },
      { applianceId: 'b-desktop', variantId: 'standard', qty: 18 },
      { applianceId: 'b-laptop', variantId: 'standard', qty: 4 },
      { applianceId: 'b-printer', variantId: 'laser', qty: 6 },
      { applianceId: 'b-copier', variantId: 'floor', qty: 2 },
      { applianceId: 'b-atm', variantId: 'standard', qty: 2 },
      { applianceId: 'b-cash-counter', variantId: 'counter', qty: 6 },
      { applianceId: 'b-network', variantId: 'server', qty: 1 },
      { applianceId: 'b-cctv', variantId: '16', qty: 1 },
      { applianceId: 'b-dispenser', variantId: 'hot-cold', qty: 2 },
      { applianceId: 'b-microwave', variantId: 'standard', qty: 1 },
      { applianceId: 'b-fridge', variantId: 'double', qty: 1 },
      { applianceId: 'b-display', variantId: '43', qty: 2 },
      { applianceId: 'b-signage', variantId: 'sign', qty: 1 },
      { applianceId: 'b-outdoor-light', variantId: '100', qty: 6 },
      { applianceId: 'b-pump', variantId: 'one', qty: 1 },
      { applianceId: 'b-access', variantId: 'access', qty: 1 },
      { applianceId: 'b-pos', variantId: 'pos', qty: 6 },
    ],
  },
];
