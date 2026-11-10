import { z } from 'zod';
import { MAX_INSTALL_KW } from '../utils/installRules.js';

const phone = z.string().trim().regex(/^\+234[789][01]\d{8}$/, 'Enter a valid Nigerian phone number');

export const createInstallSchema = z.object({
  description: z.string().trim().min(15, 'Tell the installer what to install (at least a sentence)').max(1000),
  systemKw: z.number({ invalid_type_error: 'Enter the system size in kW' }).positive('Enter the system size in kW').max(MAX_INSTALL_KW, `Systems over ${MAX_INSTALL_KW} kW need a custom quote`),
  state: z.enum(['lagos', 'abuja'], { errorMap: () => ({ message: 'Choose Lagos or Abuja' }) }),
  areaId: z.string().min(1, 'Choose an area').max(60),
  line: z.string().trim().min(6, 'Enter the street address').max(200),
  preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date').refine((d) => !Number.isNaN(Date.parse(d)), 'Choose a date'),
  contactName: z.string().trim().min(2).max(120).optional(),
  contactPhone: phone.optional(),
});
export const acceptJobSchema = z.object({ confirmAvailable: z.boolean() });
export const cancelInstallSchema = z.object({ reason: z.string().trim().min(3, 'Say why').max(300) });
export const completeInstallSchema = z.object({ summary: z.string().trim().min(10, 'Say what you installed (at least a sentence)').max(2000) }).strict();
export const installProblemSchema = z.object({ note: z.string().trim().min(10, 'Tell us what is wrong (at least a sentence)').max(500) }).strict();
export const installReviewSchema = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() }).strict();
export const assignInstallerSchema = z.object({ installerId: z.number().int().positive() }).strict();
