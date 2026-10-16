import { z } from 'zod';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(72, 'Use 72 characters or fewer')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number');

const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, ''))
  .refine((v) => v === '' || /^\+?[0-9]{7,15}$/.test(v), 'Enter a valid phone number')
  .transform((v) => (v === '' ? undefined : v))
  .optional();

export const registerSchema = z
  .object({
    role: z.enum(['individual', 'business', 'vendor']),
    fullName: z.string().trim().min(2, 'Enter your full name').max(120),
    companyName: z.string().trim().min(2, 'Enter the company name').max(160).optional(),
    email,
    phone,
    password,
  })
  .superRefine((v, ctx) => {
    if ((v.role === 'business' || v.role === 'vendor') && !v.companyName) {
      ctx.addIssue({ code: 'custom', path: ['companyName'], message: 'Enter the company name' });
    }
  });

export const verifySchema = z.object({
  email,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const resendSchema = z.object({ email });

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(200),
});
