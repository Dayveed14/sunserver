import { asyncHandler } from '../lib/httpError.js';
import { auditsService as svc } from '../services/index.js';
import { auditRef, numId } from '../utils/params.js';
import { auditModel } from '../models/settings.js';

// ---- business ----
export const request = asyncHandler(async (req, res) => res.status(201).json({ audit: await svc.request(req.user, req.valid) }));
export const listMine = asyncHandler(async (req, res) => res.json(await svc.listMine(req.user)));
export const getMine = asyncHandler(async (req, res) => res.json({ audit: await svc.getMine(req.user, auditRef(req.params.ref)) }));

// ---- field agent ----
export const catalog = (req, res) => res.json(svc.catalog());
export const jobs = asyncHandler(async (req, res) => res.json(await svc.jobs(req.user)));
export const job = asyncHandler(async (req, res) => res.json({ job: await svc.job(req.user, auditRef(req.params.ref)) }));
export const start = asyncHandler(async (req, res) => res.json({ job: await svc.start(req.user, auditRef(req.params.ref)) }));
export const saveDraft = asyncHandler(async (req, res) => res.json(await svc.saveDraft(req.user, auditRef(req.params.ref), req.valid.form)));
export const preview = asyncHandler(async (req, res) => res.json(await svc.preview(req.user, auditRef(req.params.ref), req.valid.form)));
export const submit = asyncHandler(async (req, res) => res.json(await svc.submit(req.user, auditRef(req.params.ref), req.valid.form)));
export const uploadPhoto = asyncHandler(async (req, res) => {
  const slot = String(req.params.slot);
  res.status(201).json(await svc.uploadPhoto(req.user, auditRef(req.params.ref), slot, req.body));
});

// ---- admin ----
const STATUSES = ['requested', 'assigned', 'in_progress', 'completed', 'reopened'];
export const adminList = asyncHandler(async (req, res) => res.json(await svc.adminList({ status: STATUSES.includes(req.query.status) ? req.query.status : undefined })));
export const adminGet = asyncHandler(async (req, res) => res.json({ audit: await svc.adminGet(auditRef(req.params.ref)) }));
export const assign = asyncHandler(async (req, res) => {
  const out = await svc.assign(req.user.id, auditRef(req.params.ref), req.valid.agentId);
  await auditModel.add({ adminId: req.user.id, action: 'audit.assign', target: req.params.ref, detail: { agentId: req.valid.agentId } });
  res.json(out);
});
export const reopen = asyncHandler(async (req, res) => {
  const out = await svc.reopen(req.user.id, auditRef(req.params.ref), req.valid.note);
  await auditModel.add({ adminId: req.user.id, action: 'audit.reopen', target: req.params.ref, detail: { note: req.valid.note } });
  res.json(out);
});
export const agents = asyncHandler(async (req, res) => res.json(await svc.agents()));
export const createAgent = asyncHandler(async (req, res) => {
  const out = await svc.createAgent(req.user.id, req.valid);
  await auditModel.add({ adminId: req.user.id, action: 'agent.create', target: String(out.agent.id), detail: { email: out.agent.email } });
  res.status(201).json(out);
});

// ---- private site pictures ----
export const photo = asyncHandler(async (req, res) => {
  const img = await svc.viewPhoto(req.user, numId(req.params.id));
  if (img.redirectTo) {
    res.set('Cache-Control', 'private, max-age=600');
    return res.redirect(302, img.redirectTo);
  }
  res.set({
    'Content-Type': img.mime,
    'Cache-Control': 'private, max-age=3600',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Content-Security-Policy': "default-src 'none'",
  });
  res.send(img.data);
});
