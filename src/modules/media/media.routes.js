import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { HttpError, asyncHandler } from '../../lib/httpError.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { requireVendorActive } from '../../middleware/vendorGate.js';
import { imagesRepo } from '../../repos/images.js';
import { env } from '../../config/env.js';
import { createCloudinary, optimisedUrl, parseCloudinaryUrl } from '../../lib/cloudinary.js';
import { MAX_IMAGE_BYTES } from './images.js';
import { createImageService } from './images.service.js';

const cloudinary = createCloudinary({ ...(parseCloudinaryUrl(env.cloudinary.url) ?? env.cloudinary) });
if (!cloudinary.enabled) console.warn('[images] Cloudinary is not configured: pictures are stored in the database. Set CLOUDINARY_URL to use Cloudinary.');
const imageService = createImageService({ imagesRepo, cloudinary });

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many uploads. Please wait a few minutes.' } },
});

// Vendors upload a picture as the raw request body (the app shrinks it first). Returns an id to attach to a product or deal.
export const uploadRouter = Router();
uploadRouter.post(
  '/',
  authenticate,
  requireRole('vendor'),
  requireVendorActive,
  uploadLimiter,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await imageService.store(req.user.id, req.body));
  })
);

// Anyone can view a picture; the id is not guessable in a way that matters, and pictures are product photos.
export const viewRouter = Router();
viewRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    const img = await imagesRepo.get(Number(req.params.id));
    if (!img) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    // Pictures on Cloudinary are served from its CDN, resized and in the best format for the visitor.
    if (img.remoteUrl) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.redirect(302, optimisedUrl(img.remoteUrl));
    }
    res.set({
      'Content-Type': img.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.send(img.data);
  })
);
