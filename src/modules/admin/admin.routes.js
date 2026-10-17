import { Router } from 'express';
import { HttpError, asyncHandler } from '../../lib/httpError.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { settingsSchema, userStatusSchema, vendorStatusSchema } from './admin.schemas.js';
import { adminService as svc } from './index.js';

const router = Router();
router.use(authenticate, requireRole('admin'));

const id = (req) => {
  if (!/^\d{1,18}$/.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  return Number(req.params.id);
};

router.get('/summary', asyncHandler(async (req, res) => {
  const [pending, all] = await Promise.all([svc.listVendors({ status: 'pending' }), svc.listVendors({})]);
  res.json({ pendingVendors: pending.vendors.length, vendors: all.vendors.length });
}));

router.get('/vendors', asyncHandler(async (req, res) => {
  const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : undefined;
  res.json(await svc.listVendors({ status }));
}));
router.patch('/vendors/:id/verification', validate(vendorStatusSchema), asyncHandler(async (req, res) => {
  res.json(await svc.setVendorVerification(req.user.id, id(req), req.valid.status));
}));

router.get('/users', asyncHandler(async (req, res) => {
  const role = ['individual', 'business', 'vendor', 'admin'].includes(req.query.role) ? req.query.role : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  res.json(await svc.listUsers({ role, q }));
}));
router.patch('/users/:id/status', validate(userStatusSchema), asyncHandler(async (req, res) => {
  if (id(req) === req.user.id) throw new HttpError(400, 'FORBIDDEN_TARGET', 'You cannot change your own account.');
  res.json(await svc.setUserStatus(req.user.id, id(req), req.valid.status));
}));

router.get('/settings', asyncHandler(async (req, res) => res.json(await svc.listSettings())));
router.put('/settings', validate(settingsSchema), asyncHandler(async (req, res) => {
  res.json(await svc.saveSettings(req.user.id, req.valid.changes));
}));

router.get('/audit', asyncHandler(async (req, res) => res.json(await svc.audit())));

export default router;
