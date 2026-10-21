import { asyncHandler } from '../lib/httpError.js';
import { registrationFeeService as svc } from '../services/index.js';

// The vendor's one-time registration payment. Dormant while registration is free (config/launch.js).
export const status = asyncHandler(async (req, res) => res.json(await svc.status(req.user.id)));
export const start = asyncHandler(async (req, res) => res.status(201).json(await svc.start(req.user)));
export const verify = asyncHandler(async (req, res) => res.json(await svc.verifyAndSettle(req.user, req.valid.reference)));
export const mockPay = asyncHandler(async (req, res) => res.json(await svc.mockPay(req.user, req.valid.reference)));
