import { appliance as a, v } from './helpers.js';

// Devices and wattages from David's field research spreadsheet (Sunledger_Appliance_spreadsheet.xlsx),
// added to the BUSINESS catalogue: salons, print shops, tailors, small labs and workshops.
//
// How the spreadsheet was merged:
//  - A device we already had at a similar wattage was left as it was (our figures include duty cycle and start-up surge).
//  - A device we had, but where the survey showed a bigger unit than our largest, got an extra variant below.
//  - A device we did not have is a new appliance in the "Salon, workshop & lab" category.
// Survey hours were turned into the nearest usage range the picker offers (4-5 h: 3-5 hrs, 8 h: 6-8 hrs, 9-11 h: 9-12 hrs).
//
// NOTE: about 20 survey rows list exactly 2,500 W (centrifuge, microscope, incubator ...). That looks like a rating
// or placeholder rather than a measured figure, so they are included as given but should be checked against nameplates.
export const SURVEY_CATEGORY = 'Salon, workshop & lab';

const SHOP = { defaultHours: 'h4', daytimeShare: 0.9 };

// id of an existing business appliance -> extra variants from the survey.
export const SURVEY_EXTRA_VARIANTS = {
  'b-led-light': [v('strip-150', 'Strip / tape light run (150W)', 150)],
  'b-old-light': [v('incandescent', 'Incandescent bulb (60W)', 60)],
  'b-fan': [v('ceiling-large', 'Large / industrial ceiling fan (150W)', 150), v('standing-large', 'Industrial standing fan (190W)', 190)],
  'b-desktop': [v('large-monitor', 'Desktop + large monitor (250W)', 250)],
  'b-laptop': [v('heavy', 'Heavy-use laptop (90W)', 90)],
  'b-copier': [v('heavy', 'Heavy photocopier (2,750W)', 2750)],
  'b-fridge': [v('large', 'Large fridge / freezer (500W)', 500)],
  'b-kettle': [v('large', 'Large kettle (2,500W)', 2500)],
};

const RAW_APPLIANCES = [
  // ---- Salon & beauty ----
  a('w-hair-dryer', 'Hair dryers / stretchers', SURVEY_CATEGORY, 'Salon dryers and hair stretchers.', { ...SHOP, defaultHours: 'h4', maxQty: 40 }, [v('standard', 'Hair dryer / stretcher (2,500W)', 2500)]),
  a('w-hot-comb', 'Hot combs', SURVEY_CATEGORY, 'Heated hair combs.', { ...SHOP, maxQty: 40 }, [v('standard', 'Hot comb (1,000W)', 1000)]),
  a('w-tong', 'Hair tongs / curlers', SURVEY_CATEGORY, 'Heated hair tongs.', { ...SHOP, maxQty: 40 }, [v('standard', 'Hair tong (1,500W)', 1500)]),
  a('w-clipper', 'Hair clippers', SURVEY_CATEGORY, 'Electric clippers.', { ...SHOP, defaultHours: 'h4', maxQty: 40 }, [v('standard', 'Clipper (50W)', 50)]),
  a('w-facial-light', 'Facial light machines', SURVEY_CATEGORY, 'Facial treatment lights.', { ...SHOP, maxQty: 20 }, [v('standard', 'Facial light (1,500W)', 1500)]),
  a('w-facial-steamer', 'Facial steamers', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 20 }, [v('standard', 'Facial steamer (600W)', 600)]),
  a('w-nail-light', 'Nail table lights', SURVEY_CATEGORY, 'Lamps at nail stations.', { ...SHOP, defaultHours: 'h4', maxQty: 40 }, [v('standard', 'Nail table light (1,500W)', 1500)]),
  a('w-pedicure', 'Pedicure machines', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 20 }, [v('standard', 'Pedicure machine (300W)', 300)]),
  a('w-towel-warmer', 'Towel warmers / foot baths', SURVEY_CATEGORY, 'Towel warmers and manicure foot baths.', { ...SHOP, maxQty: 20 }, [v('standard', 'Towel warmer / foot bath (600W)', 600)]),
  a('w-teeth-whitening', 'Teeth whitening machines', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'Teeth whitening machine (2,500W)', 2500)]),
  a('w-ring-light', 'Mirror / ring lights', SURVEY_CATEGORY, 'Long mirror fancy lights and ring lights.', { defaultHours: 'h10', daytimeShare: 0.3, maxQty: 40 }, [v('standard', 'Mirror / ring light (150W)', 150)]),
  a('w-hand-dryer', 'Hand dryers', SURVEY_CATEGORY, 'Wall-mounted hand dryers.', { ...SHOP, defaultHours: 'h05', maxQty: 20 }, [v('standard', 'Hand dryer (2,500W)', 2500)]),

  // ---- Printing, tailoring & fabrication ----
  a('w-laminator', 'Laminating machines', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'Laminating machine (2,750W)', 2750)]),
  a('w-plotter', 'Plotters / format printers', SURVEY_CATEGORY, 'Large-format and plotter printers.', { ...SHOP, maxQty: 10 }, [v('plotter', 'Plotter (2,500W)', 2500), v('format', 'Format printer (2,500W)', 2500)]),
  a('w-di-printer', 'DI printers', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'DI printer (2,500W)', 2500)]),
  a('w-shirt-cutter', 'Shirt cutting machines', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'Shirt cutting machine (2,500W)', 2500)]),
  a('w-sewing', 'Sewing / weaving machines', SURVEY_CATEGORY, '', { defaultHours: 'h7', daytimeShare: 0.9, maxQty: 100 }, [v('standard', 'Sewing / weaving machine (450W)', 450)]),
  a('w-coiler', 'Coilers', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'Coiler (2,500W)', 2500)]),
  a('w-stoning', 'Stoning machines', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'Stoning machine (2,500W)', 2500)]),
  a('w-soldering', 'Soldering irons', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 30 }, [v('standard', 'Soldering iron (1,000W)', 1000)]),
  a('w-workstation', 'Work stations', SURVEY_CATEGORY, 'Heavy work stations.', { ...SHOP, maxQty: 30 }, [v('standard', 'Work station (2,500W)', 2500)]),

  // ---- Lab & medical ----
  a('w-centrifuge', 'Centrifuges', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'Centrifuge (2,500W)', 2500)]),
  a('w-hematocrit', 'Micro hematocrit machines', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'Micro hematocrit machine (2,500W)', 2500)]),
  a('w-microscope', 'Microscopes', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 20 }, [v('standard', 'Microscope (2,500W)', 2500)]),
  a('w-incubator', 'Incubators', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'Incubator (2,500W)', 2500)]),
  a('w-electrophoresis', 'Electrophoresis machines', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'Electrophoresis machine (2,500W)', 2500)]),
  a('w-uv', 'UV light machines', SURVEY_CATEGORY, '', { ...SHOP, maxQty: 10 }, [v('standard', 'UV light machine (2,500W)', 2500)]),
  a('w-chiller', 'Small chillers', SURVEY_CATEGORY, 'Small cooling chillers (not building air conditioning).', { defaultHours: 'h4', daytimeShare: 0.6, dutyCycle: 0.7, surge: 3, maxQty: 10 }, [v('standard', 'Chiller (2,500W)', 2500)]),

  // ---- Everyday items the survey listed that the business catalogue lacked ----
  a('w-oven', 'Electric ovens', 'Kitchen & breakroom', 'Bakery or kitchen ovens.', { ...SHOP, maxQty: 20 }, [v('standard', 'Oven (2,500W)', 2500)]),
  a('w-washer', 'Washing machines', 'Kitchen & breakroom', '', { ...SHOP, maxQty: 20 }, [v('standard', 'Washing machine (500W)', 500)]),
  a('w-iron', 'Pressing irons', 'Kitchen & breakroom', '', { ...SHOP, maxQty: 30 }, [v('standard', 'Pressing iron (2,500W)', 2500)]),
  a('w-decoder', 'Decoders (DStv / GOtv / StarTimes)', 'Computers & office', '', { defaultHours: 'h10', daytimeShare: 0.6, maxQty: 30 }, [v('standard', 'Decoder (30W)', 30)]),
  a('w-chandelier', 'Chandeliers', 'Cooling & lighting', 'Decorative chandeliers.', { defaultHours: 'h10', daytimeShare: 0.2, maxQty: 30 }, [v('standard', 'Chandelier (500W)', 500)]),
  a('w-track-light', 'Track lights', 'Cooling & lighting', '', { defaultHours: 'h4', daytimeShare: 0.3, maxQty: 60 }, [v('standard', 'Track light (100W)', 100)]),
  a('w-speakers', 'Speakers / sound system', 'Computers & office', 'Shop or event speakers.', { ...SHOP, maxQty: 30 }, [v('standard', 'Speakers (300W)', 300)]),
];

// The first size listed is the pre-selected one.
export const SURVEY_APPLIANCES = RAW_APPLIANCES.map((ap) => ({ ...ap, variants: ap.variants.map((vr, i) => ({ ...vr, default: i === 0 })) }));
