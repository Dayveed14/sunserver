import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
import adminRoutes from './modules/admin/admin.routes.js';
import analysisRoutes from './modules/analysis/analysis.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import offersRoutes from './modules/marketplace/offers.routes.js';
import shopRoutes from './modules/marketplace/shop.routes.js';
import vendorRoutes from './modules/marketplace/vendor.routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: env.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/analysis', analysisRoutes);
  app.use('/api/vendor', vendorRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/offers', offersRoutes);
  app.use('/api/shop', shopRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
