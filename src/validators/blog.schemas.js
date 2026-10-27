import { z } from 'zod';

export const articleSchema = z.object({
  title: z.string().trim().min(5, 'Write a heading of at least 5 characters').max(160),
  summary: z.string().trim().max(300).optional().default(''),
  body: z.string().trim().min(50, 'Write at least a few sentences').max(50000),
  imageId: z.number().int().positive().nullable().optional(),
  status: z.enum(['draft', 'published']),
});
