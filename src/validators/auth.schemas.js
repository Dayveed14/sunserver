import { z } from 'zod';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(72, 'Use 72 characters or fewer')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number');

import { findArea, stateIds } from '../utils/areas.js';

// Nigerian numbers: 0803 123 4567, +234 803 123 4567 or 234803... All are stored as +234803...
const phone = z
  .string({ required_error: 'Enter your phone number', invalid_type_error: 'Enter your phone number' })
  .trim()
  .transform((v) => v.replace(/[\s()-]+/g, ''))
  .refine((v) => /^(\+?234|0)[789][01]\d{8}$/.test(v), 'Enter a valid Nigerian phone number, like 0803 123 4567')
  .transform((v) => `+234${v.replace(/^(\+?234|0)/, '')}`);

const addressSchema = z
  .object({
    line: z.string({ required_error: 'Enter your address' }).trim().min(6, 'Enter the street address').max(200, 'Keep the address under 200 characters'),
    state: z.enum(['lagos', 'abuja'], { errorMap: () => ({ message: 'Choose Lagos or Abuja' }) }),
    areaId: z.string({ required_error: 'Choose your area' }).min(1, 'Choose your area'),
  })
  .superRefine((a, ctx) => {
    if (stateIds().includes(a.state) && !findArea(a.state, a.areaId)) {
      ctx.addIssue({ code: 'custom', path: ['areaId'], message: 'Choose an area in the selected state' });
    }
  });
export { addressSchema };

// 'seller' sells only. 'company' sells, installs and can offer Energy-as-a-Service.
const vendorType = z.enum(['seller', 'company'], { errorMap: () => ({ message: 'Choose how you work with Solalium' }) });
const ROLES = ['individual', 'business', 'vendor', 'installer'];

export const registerSchema = z
  .object({
    role: z.enum(ROLES),
    vendorType: vendorType.optional(),
    fullName: z.string().trim().min(2, 'Enter your full name').max(120),
    companyName: z.string().trim().min(2, 'Enter the company name').max(160).optional(),
    email,
    phone,
    password,
    address: addressSchema,
  })
  .superRefine((v, ctx) => {
    if ((v.role === 'business' || v.role === 'vendor') && !v.companyName) {
      ctx.addIssue({ code: 'custom', path: ['companyName'], message: 'Enter the company name' });
    }
    if (v.role === 'vendor' && !v.vendorType) {
      ctx.addIssue({ code: 'custom', path: ['vendorType'], message: 'Choose how you work with Solalium' });
    }
  });

const roleOpt = z.enum(ROLES).optional();

export const verifySchema = z.object({
  email,
  role: roleOpt,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const resendSchema = z.object({ email, role: roleOpt });

export const loginSchema = z.object({
  email,
  role: roleOpt,
  password: z.string().min(1, 'Enter your password').max(200),
});

export const forgotSchema = z.object({ email });

export const resetSchema = z.object({
  token: z.string().trim().min(20, 'This reset link is not valid.').max(100, 'This reset link is not valid.'),
  password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: password,
});

export const switchSchema = z.object({ role: z.enum(ROLES) });

// Opening another account type while signed in. Company name is needed for business and vendor accounts.
export const addAccountSchema = z
  .object({
    role: z.enum(ROLES),
    vendorType: vendorType.optional(),
    companyName: z.string().trim().min(2, 'Enter the company name').max(160).optional(),
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: phone.optional(),
    address: addressSchema,
  })
  .superRefine((v, ctx) => {
    if ((v.role === 'business' || v.role === 'vendor') && !v.companyName) {
      ctx.addIssue({ code: 'custom', path: ['companyName'], message: 'Enter the company name' });
    }
    if (v.role === 'vendor' && !v.vendorType) {
      ctx.addIssue({ code: 'custom', path: ['vendorType'], message: 'Choose how you work with Solalium' });
    }
  });

export const profileSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name').max(120),
  phone,
  address: addressSchema,
});
