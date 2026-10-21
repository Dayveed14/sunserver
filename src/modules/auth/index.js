import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { VENDOR_REGISTRATION_FEE_REQUIRED } from '../../config/launch.js';
import { createMailer } from '../../lib/mailer.js';
import { usersRepo } from '../../repos/users.js';
import { otpsRepo } from '../../repos/otps.js';
import { passwordResetsRepo } from '../../repos/passwordResets.js';
import { feesService } from '../delivery/index.js';
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
  // A vendor's delivery prices to every area are worked out from where they are, whenever they sign up or move.
  onAccountCreated: async (user) => {
    if (user.role === 'vendor' && user.address_state && user.email_verified_at) {
      try {
        await feesService.refreshVendor(Number(user.id), { vendorId: Number(user.id), state: user.address_state, areaId: user.address_area });
      } catch (err) {
        console.error('[delivery] could not price deliveries for vendor', user.id, err.message);
      }
    }
  },
  config: {
    bcryptRounds: env.bcryptRounds,
    vendorRegistrationFeeRequired: VENDOR_REGISTRATION_FEE_REQUIRED,
    // Separate key from the JWT secret so one can be rotated without touching the other.
    otpSecret: crypto.createHmac('sha256', env.jwtSecret).update('sunledger-otp').digest('hex'),
    otp: env.otp,
    login: env.login,
    reset: env.reset,
    resetLink: (token) => `${env.clientOrigin.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`,
  },
});
