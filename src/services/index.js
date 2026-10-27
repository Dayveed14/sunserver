// The one place where every service is built and given the things it needs (models, Paystack, email, rules).
// Controllers import their service from here, e.g.  import { ordersService } from '../services/index.js';
// Why services are built here and not inside their own files: tests build the same services with fake models
// (see test-support/), so the business rules can be checked without a database or the internet.
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { VENDOR_REGISTRATION_FEE_REQUIRED } from '../config/launch.js';
import { createCloudinary, parseCloudinaryUrl } from '../lib/cloudinary.js';
import { createDispatchTokens } from '../lib/dispatchToken.js';
import { createMailer } from '../lib/mailer.js';
import { createPaystack } from '../lib/paystack.js';
import { articlesModel } from '../models/articles.js';
import { installationsModel } from '../models/installations.js';
import { documentsModel } from '../models/documents.js';
import { installersModel } from '../models/installers.js';
import { assessmentsModel } from '../models/assessments.js';
import { dealsModel } from '../models/deals.js';
import { deliveryFeesModel } from '../models/deliveryFees.js';
import { imagesModel } from '../models/images.js';
import { ordersModel } from '../models/orders.js';
import { otpsModel } from '../models/otps.js';
import { passwordResetsModel } from '../models/passwordResets.js';
import { productsModel } from '../models/products.js';
import { requestsModel } from '../models/requests.js';
import { auditModel, settingsModel } from '../models/settings.js';
import { usersModel } from '../models/users.js';
import { vendorsModel } from '../models/vendors.js';
import { DELIVERY_RULES } from '../utils/delivery.js';
import { FEE_RULES } from '../utils/fees.js';
import { INSTALL_RULES } from '../utils/installRules.js';
import { settingsRegistry } from '../utils/settingsRegistry.js';
import { createAdminService } from './admin.service.js';
import { createAnalysisService } from './analysis.service.js';
import { createAuthService } from './auth.service.js';
import { createCatalogService } from './catalog.service.js';
import { createFeesService } from './deliveryFees.service.js';
import { createImageService } from './images.service.js';
import { createNotifier } from './notifier.js';
import { createOffersService } from './offers.service.js';
import { createOrdersService } from './orders.service.js';
import { createRegistrationFeeService } from './registrationFee.service.js';
import { createPartnersService } from './partners.service.js';
import { partnersModel } from '../models/partners.js';
import { createSubscriptionService } from './subscription.service.js';
import { subscriptionsModel } from '../models/subscriptions.js';
import { createVerificationService } from './verification.service.js';
import { createBlogService } from './blog.service.js';
import { createInstallationsService } from './installations.service.js';
import { createShopService } from './shop.service.js';

// ---------- shared tools ----------
const mailer = createMailer({ apiKey: env.resend.apiKey, from: env.resend.from, isProd: env.isProd });
if (!env.resend.apiKey) console.warn('[mail] RESEND_API_KEY not set: verification codes will be printed to this console instead of emailed.');

export const paystack = createPaystack({ secretKey: env.paystack.secretKey, clientOrigin: env.clientOrigin, isProd: env.isProd });
if (paystack.mock) console.warn('[pay] PAYSTACK_SECRET_KEY not set: payments run in SIMULATION mode (no real money moves).');
if (!env.notify.logisticsEmail) console.warn('[notify] LOGISTICS_EMAIL not set: rider requests will not be emailed.');
if (!env.notify.adminEmail) console.warn('[notify] ADMIN_NOTIFY_EMAIL not set: the admin will not get order emails.');

export const dispatchTokens = createDispatchTokens(`${env.jwtSecret}:dispatch`);
const notifier = createNotifier({ mailer, config: { ...env.notify, appUrl: env.clientOrigin }, tokens: dispatchTokens });

const cloudinary = createCloudinary({ ...(parseCloudinaryUrl(env.cloudinary.url) ?? env.cloudinary) });
if (!cloudinary.enabled) console.warn('[images] Cloudinary is not configured: pictures are stored in the database. Set CLOUDINARY_URL to use Cloudinary.');

const clientUrl = env.clientOrigin.replace(/\/$/, '');

// ---------- services ----------
export const deliveryFeesService = createFeesService({ model: deliveryFeesModel, rules: DELIVERY_RULES });

export const authService = createAuthService({
  users: usersModel,
  otps: otpsModel,
  resets: passwordResetsModel,
  mailer,
  // A vendor's delivery prices to every area are worked out from where they are, whenever they sign up or move.
  onAccountCreated: async (user) => {
    if (user.role === 'vendor' && user.address_state && user.email_verified_at) {
      try {
        await deliveryFeesService.refreshVendor(Number(user.id), { vendorId: Number(user.id), state: user.address_state, areaId: user.address_area });
      } catch (err) {
        console.error('[delivery] could not price deliveries for vendor', user.id, err.message);
      }
    }
  },
  config: {
    bcryptRounds: env.bcryptRounds,
    vendorRegistrationFeeRequired: VENDOR_REGISTRATION_FEE_REQUIRED,
    // Separate key from the JWT secret so one can be rotated without touching the other.
    otpSecret: crypto.createHmac('sha256', env.jwtSecret).update('solalium-otp').digest('hex'),
    otp: env.otp,
    login: env.login,
    reset: env.reset,
    resetLink: (token) => `${clientUrl}/reset-password?token=${encodeURIComponent(token)}`,
  },
});

export const analysisService = createAnalysisService({ assessmentsModel });

export const imageService = createImageService({ imagesModel, cloudinary });

export const catalogService = createCatalogService({ productsModel, dealsModel, requestsModel, vendorsModel, imagesModel });

export const offersService = createOffersService({
  productsModel, dealsModel, requestsModel, assessmentsModel,
  config: { requireVerified: true },
});

export const shopService = createShopService({
  productsModel, dealsModel, feesService: deliveryFeesService,
  config: { requireVerified: true },
});

export const ordersService = createOrdersService({
  productsModel, dealsModel, ordersModel, feesService: deliveryFeesService, paystack, notifier,
  config: {
    requireVerified: true,
    maxQty: env.checkout.maxQty,
    maxTotal: env.checkout.maxTotal,
    pendingExpiryHours: env.checkout.pendingExpiryHours,
    callbackUrl: `${clientUrl}/checkout/return`,
  },
});

// FEE_RULES is the same live object the admin's Pricing & rules page edits, so a new fee applies to the next payment.
export const registrationFeeService = createRegistrationFeeService({
  vendorsModel, paystack, rules: FEE_RULES,
  config: { required: VENDOR_REGISTRATION_FEE_REQUIRED, callbackUrl: `${clientUrl}/vendor/fee/return` },
});

export const subscriptionService = createSubscriptionService({
  subscriptionsModel, paystack, notifier, auditModel, rules: FEE_RULES,
  config: { callbackUrl: `${clientUrl}/vendor/subscription/return` },
});

export const partnersService = createPartnersService({ partnersModel });

export const verificationService = createVerificationService({ vendorsModel, installersModel, documentsModel, usersModel, auditModel, cloudinary, notifier });

// INSTALL_RULES is the live object the admin's Pricing page edits, so a new price applies to the next quote.
export const installationsService = createInstallationsService({
  model: installationsModel, paystack, notifier, usersModel, rules: INSTALL_RULES,
  config: { callbackUrl: `${clientUrl}/installation/return` },
});

export const blogService = createBlogService({ articlesModel, imagesModel, auditModel });

export const adminService = createAdminService({
  documentsModel,
  registry: settingsRegistry, settingsModel, auditModel, usersModel, vendorsModel, productsModel, imagesModel,
  afterSettingsSaved: async (keys) => {
    if (keys.some((k) => k.startsWith('delivery'))) await deliveryFeesService.recomputeAll();
  },
});

// Closes delivered orders nobody confirmed and drops unpaid checkouts. Safe to run on several servers at once.
export function startHousekeeping() {
  const tick = () => {
    ordersService.housekeeping().catch((err) => console.error('[orders] housekeeping failed:', err.message));
    subscriptionService.housekeeping().catch((err) => console.error('[subscription] housekeeping failed:', err.message));
    installationsService.housekeeping().catch((err) => console.error('[install] housekeeping failed:', err.message));
  };
  const timer = setInterval(tick, env.checkout.housekeepingMinutes * 60 * 1000);
  timer.unref();
  tick();
  return timer;
}
