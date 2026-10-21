import { env } from '../../config/env.js';
import { createDispatchTokens } from '../../lib/dispatchToken.js';
import { createMailer } from '../../lib/mailer.js';
import { createPaystack } from '../../lib/paystack.js';
import { ordersRepo } from '../../repos/orders.js';
import { feesService } from '../delivery/index.js';
import { dealsRepo, productsRepo } from '../marketplace/index.js';
import { createNotifier } from './notifier.js';
import { createOrdersService } from './orders.service.js';

const mailer = createMailer({ apiKey: env.resend.apiKey, from: env.resend.from, isProd: env.isProd });
export const paystack = createPaystack({ secretKey: env.paystack.secretKey, clientOrigin: env.clientOrigin, isProd: env.isProd });
if (paystack.mock) console.warn('[pay] PAYSTACK_SECRET_KEY not set: payments run in SIMULATION mode (no real money moves).');
if (!env.notify.logisticsEmail) console.warn('[notify] LOGISTICS_EMAIL not set: rider requests will not be emailed.');
if (!env.notify.adminEmail) console.warn('[notify] ADMIN_NOTIFY_EMAIL not set: the admin will not get order emails.');

export const dispatchTokens = createDispatchTokens(`${env.jwtSecret}:dispatch`);
const notifier = createNotifier({ mailer, config: { ...env.notify, appUrl: env.clientOrigin }, tokens: dispatchTokens });

export const ordersService = createOrdersService({
  productsRepo, dealsRepo, ordersRepo, feesService, paystack, notifier,
  config: {
    requireVerified: env.vendorApprovalRequired,
    maxQty: env.checkout.maxQty,
    maxTotal: env.checkout.maxTotal,
    pendingExpiryHours: env.checkout.pendingExpiryHours,
    callbackUrl: `${env.clientOrigin.replace(/\/$/, '')}/checkout/return`,
  },
});

// Closes delivered orders nobody confirmed and drops unpaid checkouts. Safe to run on several servers at once.
export function startHousekeeping() {
  const tick = () => ordersService.housekeeping().catch((err) => console.error('[orders] housekeeping failed:', err.message));
  const timer = setInterval(tick, env.checkout.housekeepingMinutes * 60 * 1000);
  timer.unref();
  tick();
  return timer;
}
