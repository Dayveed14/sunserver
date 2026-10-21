import { z } from 'zod';
import { findArea } from '../utils/areas.js';

const item = z.object({
  kind: z.enum(['product', 'deal']),
  id: z.number().int().positive(),
  qty: z.number().int().min(1, 'Quantity must be at least 1').max(20, 'You can order up to 20 of one item'),
});

// Where the order goes. Name and phone default to the signed-in customer's own.
const destination = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().regex(/^\+234[789][01]\d{8}$/, 'Enter a valid Nigerian phone number').optional(),
    line: z.string().trim().min(6, 'Enter the street address').max(200),
    state: z.enum(['lagos', 'abuja'], { errorMap: () => ({ message: 'Choose Lagos or Abuja' }) }),
    areaId: z.string().min(1, 'Choose an area'),
  })
  .superRefine((d, ctx) => {
    if (!findArea(d.state, d.areaId)) ctx.addIssue({ code: 'custom', path: ['areaId'], message: 'Choose an area in the selected state' });
  });

export const cartSchema = z.object({
  items: z.array(item).min(1, 'Your cart is empty').max(30, 'Too many items in one order'),
  destination: destination.optional(), // omitted = the customer's saved address
});

export const verifySchema = z.object({ reference: z.string().trim().min(6).max(80) });
export const noteSchema = z.object({ note: z.string().trim().max(300).optional() });
export const dispatchSchema = z.object({ t: z.string().min(10).max(200) });
