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
    database: process.env.DB_NAME ?? 'sunledger',
  },

  resend: {
    apiKey: process.env.RESEND_API_KEY ?? '',
    from: process.env.MAIL_FROM ?? 'Sunledger <onboarding@resend.dev>',
  },

  // While there is no admin console, pending vendors are shown to customers. Set to 1 once vendors
  // are verified by hand (verification_status = 'verified') and only those should appear.
  vendorApprovalRequired: process.env.VENDOR_APPROVAL_REQUIRED === '1',

  otp: { ttlMinutes: 10, maxAttempts: 5, resendCooldownSeconds: 60, maxSendsPerHour: 5 },
  login: { maxFailures: 5, lockMinutes: 15 },
  reset: { ttlMinutes: 60, cooldownSeconds: 60, maxPerHour: 5 },
};
