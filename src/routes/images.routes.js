import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as c from '../controllers/images.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { requireVendorActive } from '../middleware/vendorGate.js';
import { MAX_IMAGE_BYTES } from '../utils/images.js';

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many uploads. Please wait a few minutes.' } },
});
const rawImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES });

// POST /api/vendor/images: a vendor uploads a picture.
export const vendorUploadRouter = Router();
vendorUploadRouter.post('/', authenticate, requireRole('vendor'), requireVendorActive, uploadLimiter, rawImage, c.upload);

// POST /api/admin/images: the admin uploads a picture when editing a product.
export const adminUploadRouter = Router();
adminUploadRouter.post('/', authenticate, requireRole('admin'), uploadLimiter, rawImage, c.upload);

// GET /api/images/:id: anyone can view a picture.
export const viewRouter = Router();
viewRouter.get('/:id', c.view);
