import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
import analysisRoutes from './modules/analysis/analysis.routes.js';
import authRoutes from './modules/auth/auth.routes.js';

export function createApp() {
  const app = express();
const allowedOrigins = [
  "http://localhost:5173",
  "https://sunledger-eight.vercel.app",
  "https://localhost",
];

  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/analysis', analysisRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
