import { asyncHandler } from '../lib/httpError.js';
import { blogService as svc } from '../services/index.js';
import { numId } from '../utils/params.js';
import { HttpError } from '../lib/httpError.js';
import { CATEGORIES, CATEGORY_KEYS, SECTIONS, SECTION_KEYS } from '../utils/blogTaxonomy.js';

export const list = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 24, 1), 50);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const pick = (value, allowed, field) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !allowed.includes(value)) throw new HttpError(400, 'VALIDATION_ERROR', `Unknown ${field}.`);
    return value;
  };
  const section = pick(req.query.section, SECTION_KEYS, 'section');
  const category = pick(req.query.category, CATEGORY_KEYS, 'category');
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ ...(await svc.list({ limit, offset, section, category })), sections: SECTIONS, categories: CATEGORIES });
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
