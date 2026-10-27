import { z } from 'zod';

export const settingsSchema = z.object({
  changes: z
    .record(z.string().max(80), z.number({ invalid_type_error: 'Enter a number.' }).finite().nullable())
    .refine((c) => Object.keys(c).length > 0 && Object.keys(c).length <= 60, 'Nothing to save.'),
});

export const vendorStatusSchema = z.object({ status: z.enum(['pending', 'verified', 'rejected']), note: z.string().trim().max(500).optional() });
export const userStatusSchema = z.object({ status: z.enum(['active', 'suspended']) });
