import { asyncHandler } from '../lib/httpError.js';
import { imageService } from '../services/index.js';
import { numId } from '../utils/params.js';

// Upload: the picture arrives as the raw request body (the app shrinks it first). Returns an id to attach to a product or deal.
export const upload = asyncHandler(async (req, res) => res.status(201).json(await imageService.store(req.user.id, req.body)));

// View: anyone can view a picture; they are product photos.
export const view = asyncHandler(async (req, res) => {
  const img = await imageService.view(numId(req.params.id));
  if (img.redirectTo) {
    res.set('Cache-Control', 'public, max-age=86400');
    return res.redirect(302, img.redirectTo);
  }
  res.set({
    'Content-Type': img.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Security-Policy': "default-src 'none'",
  });
  res.send(img.data);
});
