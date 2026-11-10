import { z } from 'zod';
import { EQUIPMENT, FAULT_TYPES, URGENCY } from '../utils/repairRules.js';

const phone = z.string().trim().regex(/^\+234[789][01]\d{8}$/, 'Enter a valid Nigerian phone number');
const ids = (list) => list.map((x) => x.id);

export const createRepairSchema = z.object({
  faultType: z.enum(ids(FAULT_TYPES), { errorMap: () => ({ message: 'Choose what is wrong' }) }),
  description: z.string().trim().min(15, 'Describe the fault in a sentence or two').max(1500),
  equipment: z.array(z.enum(ids(EQUIPMENT))).min(1, 'Choose the equipment that is affected').max(EQUIPMENT.length).transform((a) => [...new Set(a)]),
  urgency: z.enum(ids(URGENCY), { errorMap: () => ({ message: 'Choose how urgent it is' }) }),
  state: z.enum(['lagos', 'abuja'], { errorMap: () => ({ message: 'Choose Lagos or Abuja' }) }),
  areaId: z.string().min(1, 'Choose an area').max(60),
  line: z.string().trim().min(6, 'Enter the street address').max(200),
  contactName: z.string().trim().min(2).max(120).optional(),
  contactPhone: phone.optional(),
}).strict();

export const repairCancelSchema = z.object({ reason: z.string().trim().min(3, 'Say why').max(300) }).strict();
export const assignTechnicianSchema = z.object({ technicianId: z.number().int().positive() }).strict();

const money = z.number().int().min(0).max(5_000_000);
export const repairReportSchema = z.object({
  findings: z.string().trim().min(10, 'Describe what you found (at least a sentence)').max(2000),
  parts: z.array(z.object({ name: z.string().trim().min(2).max(120), qty: z.number().int().min(1).max(999), unitPrice: money }).strict()).max(20),
  labour: money,
  estimatedHours: z.number().int().min(1, 'Give a time estimate in hours').max(720),
}).strict();
