import { z } from 'zod';
import { PRIORITY_IDS } from '../utils/priorities.js';

const id = z.string().trim().min(1).max(40);

export const estimateSchema = z.object({
  segment: z.enum(['home', 'business']),
  disco: z.string().trim().min(1).max(20).default('aedc'),
  supplyBand: z.enum(['A', 'B', 'C', 'D', 'E']).nullable().optional(),
  // What the customer can spend (naira). Optional: asked first so we can say early whether solar fits.
  budget: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  // The newer guided flow: who it is for, how long to keep power on in a cut, and what matters most (in order).
  who: z.enum(['home', 'small_business', 'office', 'industrial', 'farm', 'institution', 'other']).optional(),
  backupKey: z.enum(['b4', 'b6', 'b8', 'b12', 'b24', 'cont']).optional(),
  priorities: z.array(z.enum(PRIORITY_IDS)).max(9).optional(),
  criticalIds: z.array(id).max(120).optional(),
  // 'auto' lets us pick the configuration we suggest; or choose one yourself.
  configKey: z.enum(['auto', 'essential', 'comfortable', 'whole', 'budget']).optional(),
  place: z.object({
    state: z.string().trim().max(40).optional(),
    area: z.string().trim().max(80).optional(),
    propertyType: z.string().trim().max(40).optional(),
    space: z.string().trim().max(40).optional(),
    gridConnected: z.enum(['yes', 'no', 'sometimes']).optional(),
    existing: z.array(z.enum(['solar', 'inverter', 'battery', 'generator'])).max(4).optional(),
  }).optional(),
  items: z
    .array(
      z.object({
        applianceId: id,
        variantId: id,
        qty: z.number().int().min(1).max(2000),
        hoursKey: z.string().trim().max(10).optional(),
      })
    )
    .min(1, 'Choose at least one item')
    .max(120),
});

export const interestSchema = z.object({
  category: z.enum(['cng', 'biogas', 'biomass', 'mini_grid', 'hybrid']),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(190),
});
