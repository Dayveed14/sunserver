import { z } from 'zod';

export const startSubscriptionSchema = z.object({ months: z.coerce.number().int().refine((n) => [1, 3, 6, 12].includes(n), 'Choose 1, 3, 6 or 12 months.').default(1) });
export const grantSchema = z.object({ days: z.coerce.number().int().min(1, 'At least 1 day').max(366, 'At most 366 days') });
export const grantAllSchema = z.object({ days: z.coerce.number().int().min(1).max(366), vendorType: z.enum(['seller', 'company']).optional() });
