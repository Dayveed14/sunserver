import { z } from 'zod';

const id = z.string().trim().min(1).max(40);

export const estimateSchema = z.object({
  segment: z.enum(['home', 'business']),
  disco: z.string().trim().min(1).max(20).default('aedc'),
  supplyBand: z.enum(['A', 'B', 'C', 'D', 'E']).nullable().optional(),
  // What the customer can spend (naira). Optional: asked first so we can say early whether solar fits.
  budget: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
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
