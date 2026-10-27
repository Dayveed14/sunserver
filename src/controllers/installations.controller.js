import { asyncHandler } from '../lib/httpError.js';
import { installationsService as svc } from '../services/index.js';
import { auditModel } from '../models/settings.js';

const audit = (entry) => auditModel.add(entry);

// ---- customer ----
export const bands = (req, res) => res.json(svc.bands());
export const list = asyncHandler(async (req, res) => res.json(await svc.list(req.user)));
export const create = asyncHandler(async (req, res) => res.status(201).json({ request: await svc.create(req.user, req.valid) }));
export const get = asyncHandler(async (req, res) => res.json({ request: await svc.get(req.user, req.params.ref) }));
export const pay = asyncHandler(async (req, res) => res.status(201).json(await svc.pay(req.user, req.params.ref)));
export const verify = asyncHandler(async (req, res) => res.json(await svc.verifyAndSettle(req.user, req.valid.reference)));
export const mockPay = asyncHandler(async (req, res) => res.json(await svc.mockPay(req.user, req.valid.reference)));
export const cancel = asyncHandler(async (req, res) => res.json(await svc.cancel(req.user, req.params.ref)));
export const confirm = asyncHandler(async (req, res) => res.json(await svc.confirm(req.user, req.params.ref)));

// ---- installer ----
export const openJobs = asyncHandler(async (req, res) => res.json(await svc.openJobs(req.user)));
export const myJobs = asyncHandler(async (req, res) => res.json(await svc.myJobs(req.user)));
export const job = asyncHandler(async (req, res) => res.json(await svc.job(req.user, req.params.ref)));
export const accept = asyncHandler(async (req, res) => res.json(await svc.accept(req.user, req.params.ref, req.valid)));
export const decline = asyncHandler(async (req, res) => res.json(await svc.decline(req.user, req.params.ref)));
export const done = asyncHandler(async (req, res) => res.json(await svc.done(req.user, req.params.ref)));

// ---- admin ----
export const adminList = asyncHandler(async (req, res) => {
  const status = ['open', 'assigned', 'installer_done', 'completed', 'cancelled', 'awaiting_payment'].includes(req.query.status) ? req.query.status : undefined;
  res.json(await svc.adminList({ status }));
});
export const adminGet = asyncHandler(async (req, res) => res.json(await svc.adminGet(req.params.ref)));
export const adminCancel = asyncHandler(async (req, res) => res.json(await svc.adminCancel(req.user.id, req.params.ref, req.valid.reason, audit)));
export const adminPayout = asyncHandler(async (req, res) => res.json(await svc.adminPayoutPaid(req.user.id, req.params.ref, audit)));
export const adminRefunded = asyncHandler(async (req, res) => res.json(await svc.adminRefunded(req.user.id, req.params.ref, audit)));
