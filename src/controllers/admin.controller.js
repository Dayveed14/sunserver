import { HttpError, asyncHandler } from '../lib/httpError.js';
import { adminService as svc } from '../services/index.js';
import { numId, queryText } from '../utils/params.js';

export const summary = asyncHandler(async (req, res) => {
  const [pending, all] = await Promise.all([svc.listVendors({ status: 'pending' }), svc.listVendors({})]);
  res.json({ pendingVendors: pending.vendors.length, vendors: all.vendors.length });
});

// ---- Vendors ----
export const listVendors = asyncHandler(async (req, res) => {
  const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : undefined;
  res.json(await svc.listVendors({ status }));
});
export const setVendorVerification = asyncHandler(async (req, res) => {
  res.json(await svc.setVendorVerification(req.user.id, numId(req.params.id), req.valid.status));
});

// ---- Users ----
export const listUsers = asyncHandler(async (req, res) => {
  const role = ['individual', 'business', 'vendor', 'admin'].includes(req.query.role) ? req.query.role : undefined;
  res.json(await svc.listUsers({ role, q: queryText(req.query.q, 80) ?? '' }));
});
export const setUserStatus = asyncHandler(async (req, res) => {
  const id = numId(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'FORBIDDEN_TARGET', 'You cannot change your own account.');
  res.json(await svc.setUserStatus(req.user.id, id, req.valid.status));
});

// ---- Products (any vendor's) ----
export const listProducts = asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await svc.listProducts({
    status: ['active', 'hidden'].includes(q.status) ? q.status : undefined,
    category: ['panel', 'inverter', 'battery'].includes(q.category) ? q.category : undefined,
    vendorId: /^\d{1,18}$/.test(String(q.vendorId ?? '')) ? Number(q.vendorId) : undefined,
    search: queryText(q.q, 60),
  }));
});
export const updateProduct = asyncHandler(async (req, res) => res.json({ product: await svc.updateProduct(req.user.id, numId(req.params.id), req.valid) }));
export const archiveProduct = asyncHandler(async (req, res) => {
  await svc.archiveProduct(req.user.id, numId(req.params.id));
  res.status(204).end();
});

// ---- Pricing & rules ----
export const listSettings = asyncHandler(async (req, res) => res.json(await svc.listSettings()));
export const saveSettings = asyncHandler(async (req, res) => res.json(await svc.saveSettings(req.user.id, req.valid.changes)));

export const audit = asyncHandler(async (req, res) => res.json(await svc.audit()));
