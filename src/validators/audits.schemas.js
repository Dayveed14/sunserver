import { z } from 'zod';
import { auditDraftSchema } from '../utils/auditRules.js';

const phone = z.string().trim().regex(/^\+234[789][01]\d{8}$/, 'Enter a valid Nigerian phone number');

export const requestAuditSchema = z.object({
  contactName: z.string().trim().min(2, 'Enter a contact name').max(120).optional(),
  contactPhone: phone.optional(),
  state: z.enum(['lagos', 'abuja'], { errorMap: () => ({ message: 'Choose Lagos or Abuja' }) }),
  areaId: z.string().min(1, 'Choose an area').max(60),
  line: z.string().trim().min(6, 'Enter the street address or plaza').max(200),
  preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date').refine((d) => !Number.isNaN(Date.parse(d)), 'Choose a date').optional(),
  notes: z.string().trim().max(500).optional(),
});

export const formBodySchema = z.object({ form: auditDraftSchema });
export const technicalReviewSchema = z.object({ note: z.string().trim().min(5, 'Say what the engineer should check').max(500) });
export const approveSchema = z.object({ note: z.string().trim().max(500).optional() });
export const reopenSchema = z.object({ note: z.string().trim().min(5, 'Say what needs rechecking').max(500) });
export const assignSchema = z.object({ agentId: z.number().int().positive('Choose an agent') });
export const createAgentSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the agent\'s name').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(254),
  phone: phone.optional(),
});
