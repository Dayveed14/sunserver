import { asyncHandler } from '../lib/httpError.js';
import { partnersService as svc } from '../services/index.js';

export const list = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await svc.list());
});
