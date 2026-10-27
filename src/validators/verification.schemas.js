import { z } from 'zod';
import { DOCUMENT_KINDS } from '../utils/documents.js';

export const quizSchema = z.object({
  answers: z.record(z.string().max(40), z.string().max(4)),
  yearsExperience: z.number().int().min(0).max(60).optional(),
});
export const decisionSchema = z.object({ status: z.enum(['pending', 'verified', 'rejected']), note: z.string().trim().max(500).optional() });
export const documentKindSchema = z.enum(DOCUMENT_KINDS);
