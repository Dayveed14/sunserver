import { z } from 'zod';
import { CATEGORY_KEYS, SECTION_KEYS } from '../utils/blogTaxonomy.js';

export const articleSchema = z.object({
  title: z.string().trim().min(5, 'Write a heading of at least 5 characters').max(160),
  summary: z.string().trim().max(300).optional().default(''),
  body: z.string().trim().min(50, 'Write at least a few sentences').max(50000),
  imageId: z.number().int().positive().nullable().optional(),
  section: z.enum(SECTION_KEYS).default('news'),
  category: z.enum(CATEGORY_KEYS).default('news'),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date').nullable().optional(),
  eventPlace: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['draft', 'published']),
}).superRefine((a, ctx) => {
  if (a.section === 'events' && !a.eventDate) ctx.addIssue({ code: 'custom', path: ['eventDate'], message: 'Choose the date of the event.' });
});
