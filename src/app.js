import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
import adminRoutes from './modules/admin/admin.routes.js';
import analysisRoutes from './modules/analysis/analysis.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import { uploadRouter, viewRouter } from './modules/media/media.routes.js';
import { ordersService } from './modules/orders/index.js';
import { createWebhookHandler } from './modules/orders/orders.http.js';
import { adminOrdersRouter, customerRouter, dispatchRouter, vendorOrdersRouter } from './modules/orders/orders.routes.js';
import { webhookLimiter } from './middleware/rateLimits.js';
import feeRoutes from './modules/vendors/fee.routes.js';
import { FEE_REF_PREFIX } from './modules/vendors/registrationFee.service.js';
import { registrationFee } from './modules/vendors/index.js';
import offersRoutes from './modules/marketplace/offers.routes.js';
import shopRoutes from './modules/marketplace/shop.routes.js';
import vendorRoutes from './modules/marketplace/vendor.routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: env.clientOrigin, credentials: true }));
  // Paystack's webhook needs the exact bytes it sent, so it is read raw, before JSON parsing.
  app.post('/api/webhooks/paystack', webhookLimiter, express.raw({ type: '*/*', limit: '200kb' }),
    createWebhookHandler({
      secretKey: env.paystack.secretKey,
      // One Paystack webhook serves both kinds of payment: vendor registration fees (VF-...) and orders.
      service: { handleWebhook: (event) => (String(event?.data?.reference ?? '').startsWith(FEE_REF_PREFIX) ? registrationFee.handleWebhook(event) : ordersService.handleWebhook(event)) },
    }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/analysis', analysisRoutes);
  app.use('/api/vendor/images', uploadRouter);
  app.use('/api/images', viewRouter);
  app.use('/api/vendor/fee', feeRoutes);
  app.use('/api/vendor/orders', vendorOrdersRouter);
  app.use('/api/vendor', vendorRoutes);
  app.use('/api/admin/orders', adminOrdersRouter);
  app.use('/api/admin', adminRoutes);
  app.use('/api/dispatch', dispatchRouter);
  app.use('/api', customerRouter);
  app.use('/api/offers', offersRoutes);
  app.use('/api/shop', shopRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
