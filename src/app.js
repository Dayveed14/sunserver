import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { requestLogger } from './middleware/requestLogger.js';
import { query } from './db/pool.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { mountRoutes } from './routes/index.js';
import webhookRoutes from './routes/webhook.routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');

  app.use(requestLogger);
  app.use(helmet());
  app.use(cors({ origin: env.clientOrigin, credentials: true }));
  // Paystack's webhook needs the exact bytes it sent, so it is read raw, before JSON parsing.
  app.use('/api/webhooks', webhookRoutes);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // /health: is the process up (for the host's restart check). /ready: can it reach the database (for uptime monitors).
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/ready', async (req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true, db: 'up' });
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'readiness check failed', code: err.code ?? err.message }));
      res.status(503).json({ ok: false, db: 'down' });
    }
  });
  mountRoutes(app);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
