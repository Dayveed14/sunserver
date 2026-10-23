-- Run this ONCE on a database that already exists (for example TiDB Cloud) to allow the new product types.
-- `npm run db:init` does the same thing automatically, so you only need this file if you run SQL by hand.
-- New values are added at the END of the list, which keeps every existing product valid.
ALTER TABLE products
MODIFY COLUMN category ENUM(
  'panel',
  'inverter',
  'battery',
  'controller',
  'mounting',
  'cable',
  'connector',
  'protection',
  'surge_protection',
  'distribution',
  'earthing',
  'accessory',
  'meter',
  'monitoring',
  'transfer_switch',
  'energy_management',
  'portable_power',
  'generator',
  'pump',
  'streetlight',
  'lighting',
  'kit'
) NOT NULL;
