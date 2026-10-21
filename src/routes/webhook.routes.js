import express, { Router } from 'express';
import { env } from '../config/env.js';
import { createWebhookHandler } from '../controllers/webhook.controller.js';
import { webhookLimiter } from '../middleware/rateLimits.js';
import { ordersService, registrationFeeService } from '../services/index.js';
import { FEE_REF_PREFIX } from '../services/registrationFee.service.js';

// POST /api/webhooks/paystack. Mounted BEFORE express.json() in app.js: the signature is a hash of the raw bytes.
// One Paystack webhook serves both kinds of payment: vendor registration fees (VF-...) and orders.
const router = Router();
router.post('/paystack', webhookLimiter, express.raw({ type: '*/*', limit: '200kb' }),
  createWebhookHandler({
    secretKey: env.paystack.secretKey,
    service: {
      handleWebhook: (event) => (String(event?.data?.reference ?? '').startsWith(FEE_REF_PREFIX)
        ? registrationFeeService.handleWebhook(event)
        : ordersService.handleWebhook(event)),
    },
  }));

export default router;
