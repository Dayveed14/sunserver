import { asyncHandler } from '../lib/httpError.js';
import { subscriptionService as svc } from '../services/index.js';
import { numId } from '../utils/params.js';

// A vendor's own subscription.
export const status = asyncHandler(async (req, res) => res.json(await svc.status(req.user.id)));
export const start = asyncHandler(async (req, res) => res.status(201).json(await svc.start(req.user, req.valid.months)));
export const verify = asyncHandler(async (req, res) => res.json(await svc.verifyAndSettle(req.user, req.valid.reference)));
export const mockPay = asyncHandler(async (req, res) => res.json(await svc.mockPay(req.user, req.valid.reference)));

// The admin's view.
export const adminList = asyncHandler(async (req, res) => res.json(await svc.adminList()));
export const adminGrant = asyncHandler(async (req, res) => res.json(await svc.adminGrant(req.user.id, numId(req.params.id), req.valid.days)));
export const adminGrantAll = asyncHandler(async (req, res) => res.json(await svc.adminGrantAll(req.user.id, req.valid.days, req.valid.vendorType ?? null)));
