import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { createMailer } from '../../lib/mailer.js';
import { usersRepo } from '../../repos/users.js';
import { otpsRepo } from '../../repos/otps.js';
import { passwordResetsRepo } from '../../repos/passwordResets.js';
import { createAuthService } from './auth.service.js';

const mailer = createMailer({ apiKey: env.resend.apiKey, from: env.resend.from, isProd: env.isProd });

if (!env.resend.apiKey) {
  console.warn('[mail] RESEND_API_KEY not set: verification codes will be printed to this console instead of emailed.');
}

export const authService = createAuthService({
  users: usersRepo,
  otps: otpsRepo,
  resets: passwordResetsRepo,
  mailer,
  config: {
    bcryptRounds: env.bcryptRounds,
    // Separate key from the JWT secret so one can be rotated without touching the other.
    otpSecret: crypto.createHmac('sha256', env.jwtSecret).update('sunledger-otp').digest('hex'),
    otp: env.otp,
    login: env.login,
    reset: env.reset,
    resetLink: (token) => `${env.clientOrigin.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`,
  },
});
