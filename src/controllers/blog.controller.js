import { asyncHandler } from '../lib/httpError.js';
import { blogService as svc } from '../services/index.js';
import { numId } from '../utils/params.js';

export const list = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 24, 1), 50);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await svc.list({ limit, offset }));
});
export const get = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await svc.get(req.params.slug));
});

export const adminList = asyncHandler(async (req, res) => res.json(await svc.adminList()));
export const adminGet = asyncHandler(async (req, res) => res.json(await svc.adminGet(numId(req.params.id))));
export const adminCreate = asyncHandler(async (req, res) => res.status(201).json(await svc.create(req.user.id, req.valid)));
export const adminUpdate = asyncHandler(async (req, res) => res.json(await svc.update(req.user.id, numId(req.params.id), req.valid)));
export const adminDelete = asyncHandler(async (req, res) => {
  await svc.remove(req.user.id, numId(req.params.id));
  res.status(204).end();
});
