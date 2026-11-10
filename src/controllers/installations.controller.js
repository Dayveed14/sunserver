import { asyncHandler, HttpError } from '../lib/httpError.js';
import { optimisedUrl } from '../lib/cloudinary.js';
import { installationsService as svc } from '../services/index.js';
import { auditModel } from '../models/settings.js';

const audit = (entry) => auditModel.add(entry);
const numId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  return n;
};
const kindOf = (v) => {
  if (!['before', 'after'].includes(v)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  return v;
};
const body = (req) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'INVALID_IMAGE', 'Upload a JPEG, PNG or WebP picture.');
  return req.body;
};
const sendFile = (res, f) => {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
  if (f.remoteUrl) return res.redirect(302, optimisedUrl(f.remoteUrl, 'f_auto,q_auto,w_1600,c_limit'));
  res.set('Content-Type', f.mime);
  return res.send(f.data);
};

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
export const noShow = asyncHandler(async (req, res) => res.json(await svc.noShow(req.user, req.params.ref)));
export const problem = asyncHandler(async (req, res) => res.json(await svc.reportProblem(req.user, req.params.ref, req.valid.note)));
export const review = asyncHandler(async (req, res) => res.status(201).json(await svc.review(req.user, req.params.ref, req.valid)));
export const photo = asyncHandler(async (req, res) => sendFile(res, await svc.photoFile(req.user, req.params.ref, numId(req.params.id))));

// ---- installer ----
export const openJobs = asyncHandler(async (req, res) => res.json(await svc.openJobs(req.user)));
export const myJobs = asyncHandler(async (req, res) => res.json(await svc.myJobs(req.user)));
export const job = asyncHandler(async (req, res) => res.json(await svc.job(req.user, req.params.ref)));
export const accept = asyncHandler(async (req, res) => res.json(await svc.accept(req.user, req.params.ref, req.valid)));
export const decline = asyncHandler(async (req, res) => res.json(await svc.decline(req.user, req.params.ref)));
export const onMyWay = asyncHandler(async (req, res) => res.json(await svc.onMyWay(req.user, req.params.ref)));
export const arrived = asyncHandler(async (req, res) => res.json(await svc.arrived(req.user, req.params.ref)));
export const start = asyncHandler(async (req, res) => res.json(await svc.start(req.user, req.params.ref)));
export const addPhoto = asyncHandler(async (req, res) => res.status(201).json(await svc.addPhoto(req.user, req.params.ref, kindOf(req.params.kind), body(req))));
export const removePhoto = asyncHandler(async (req, res) => res.json(await svc.removePhoto(req.user, req.params.ref, numId(req.params.id))));
export const complete = asyncHandler(async (req, res) => res.json(await svc.complete(req.user, req.params.ref, req.valid.summary)));

// ---- admin ----
export const adminList = asyncHandler(async (req, res) => {
  const status = ['finding', 'assigned', 'on_the_way', 'on_site', 'in_progress', 'installer_done', 'completed', 'cancelled', 'awaiting_payment'].includes(req.query.status) ? req.query.status : undefined;
  res.json(await svc.adminList({ status, needsAction: req.query.needsAction === '1' }));
});
export const adminGet = asyncHandler(async (req, res) => res.json(await svc.adminGet(req.params.ref)));
export const adminApprove = asyncHandler(async (req, res) => res.json(await svc.approve(req.user.id, req.params.ref, audit)));
export const adminDecline = asyncHandler(async (req, res) => res.json(await svc.declineRecommendation(req.user.id, req.params.ref, audit)));
export const adminAssign = asyncHandler(async (req, res) => res.json(await svc.assign(req.user.id, req.params.ref, req.valid.installerId, audit)));
export const adminCancel = asyncHandler(async (req, res) => res.json(await svc.adminCancel(req.user.id, req.params.ref, req.valid.reason, audit)));
export const adminConfirm = asyncHandler(async (req, res) => res.json(await svc.adminConfirm(req.user.id, req.params.ref, audit)));
export const adminPayout = asyncHandler(async (req, res) => res.json(await svc.adminPayoutPaid(req.user.id, req.params.ref, audit)));
export const adminRefunded = asyncHandler(async (req, res) => res.json(await svc.adminRefunded(req.user.id, req.params.ref, audit)));
