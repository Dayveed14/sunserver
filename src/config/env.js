import 'dotenv/config';
import crypto from 'node:crypto';

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProd = nodeEnv === 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  if (isProd) {
    throw new Error('JWT_SECRET must be set to a random string of at least 32 characters in production.');
  }
  jwtSecret = crypto.randomBytes(48).toString('hex');
  console.warn(
    '[env] JWT_SECRET is missing or too short. Using a temporary secret, so sessions reset whenever the server restarts.'
  );
}

if (isProd) {
  const origin = process.env.CLIENT_ORIGIN ?? '';
  if (!/^https:\/\/[^/]+$/.test(origin)) {
    throw new Error('CLIENT_ORIGIN must be set to your site address in production, starting with https:// and with no path or trailing slash (for example https://solariun.com).');
  }
}

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const env = {
  nodeEnv,
  isProd,
  port: int(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  trustProxy: int(process.env.TRUST_PROXY, 0),

  jwtSecret,
  sessionDays: int(process.env.SESSION_DAYS, 7),
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),

  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'solalium',
    // TiDB Cloud needs an encrypted connection; a local database on this computer does not. Set DB_SSL=true or false to force it.
    ssl: process.env.DB_SSL ? process.env.DB_SSL === 'true' : !['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '127.0.0.1'),
  },

  resend: {
    apiKey: process.env.RESEND_API_KEY ?? '',
    from: process.env.MAIL_FROM ?? 'Solariun <onboarding@resend.dev>',
  },


  paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY ?? '' },
  // Product pictures. Either CLOUDINARY_URL (cloudinary://KEY:SECRET@CLOUD_NAME, as shown on your Cloudinary dashboard)
  // or the three separate values. With neither, pictures are kept in the database instead (fine for testing).
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
    url: process.env.CLOUDINARY_URL ?? '',
  },
  // Where order updates go besides the customer and vendor. The logistics partner gets "send a rider" and
  // pickup/delivery notices; the admin address gets a copy of everything.
  notify: {
    logisticsEmail: process.env.LOGISTICS_EMAIL ?? '',
    adminEmail: process.env.ADMIN_NOTIFY_EMAIL ?? '',
  },
  checkout: { pendingExpiryHours: 24, maxQty: 20, maxTotal: 20_000_000, housekeepingMinutes: 5 },

  otp: { ttlMinutes: 10, maxAttempts: 5, resendCooldownSeconds: 60, maxSendsPerHour: 5 },
  login: { maxFailures: 5, lockMinutes: 15 },
  reset: { ttlMinutes: 60, cooldownSeconds: 60, maxPerHour: 5 },
};
