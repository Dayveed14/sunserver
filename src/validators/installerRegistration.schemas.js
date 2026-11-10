import { z } from 'zod';
import { BUSINESS_STATUS, CAPACITY, EXPERIENCE, MAX_REFERENCES, PROJECT_TYPES, QUALIFICATION, RESPONSE_TIME, TRAVEL_KM } from '../utils/installerRegistration.js';

const ids = (list) => list.map((x) => x.id);
const oneOf = (list, message) => z.enum(ids(list), { errorMap: () => ({ message }) });

// Nigerian numbers, stored as +234803...
const phone = z
  .string({ required_error: 'Enter a phone number', invalid_type_error: 'Enter a phone number' })
  .trim()
  .transform((v) => v.replace(/[\s()-]+/g, ''))
  .refine((v) => /^(\+?234|0)[789][01]\d{8}$/.test(v), 'Enter a valid Nigerian phone number, like 0803 123 4567')
  .transform((v) => `+234${v.replace(/^(\+?234|0)/, '')}`);

// Every field is optional so each step of the form can be saved on its own.
export const registrationPatchSchema = z
  .object({
    businessStatus: oneOf(BUSINESS_STATUS, 'Choose one').optional(),
    travelKm: z.number().int().refine((v) => TRAVEL_KM.some((t) => t.id === v), 'Choose how far you will travel').optional(),
    experienceBand: oneOf(EXPERIENCE, 'Choose your years of experience').optional(),
    qualification: oneOf(QUALIFICATION, 'Choose one').optional(),
    about: z.string().trim().max(1000, 'Keep this under 1,000 characters').optional(),
    projectTypes: z.array(oneOf(PROJECT_TYPES, 'Choose from the list')).max(PROJECT_TYPES.length).refine((a) => new Set(a).size === a.length, 'Each type once').optional(),
    capacity: z.number().int().refine((v) => CAPACITY.includes(v), 'Choose how many jobs you can handle').optional(),
    responseTime: oneOf(RESPONSE_TIME, 'Choose a response time').optional(),
    acceptsRepairs: z.boolean().optional(),
  })
  .strict();

export const referencesSchema = z.object({
  references: z.array(z.object({
    name: z.string().trim().min(2, 'Enter their name').max(120),
    phone,
    relationship: z.string().trim().min(2, 'Say how they know you').max(80),
  })).max(MAX_REFERENCES, `At most ${MAX_REFERENCES} references`),
});

export const submitRegistrationSchema = z.object({
  declaration: z.literal(true, { errorMap: () => ({ message: 'Please tick the box to confirm' }) }),
});

export const referenceCheckSchema = z.object({
  called: z.boolean(),
  note: z.string().trim().max(300).optional(),
});
