import { env } from '../../config/env.js';
import { VENDOR_REGISTRATION_FEE_REQUIRED } from '../../config/launch.js';
import { vendorsRepo } from '../../repos/vendors.js';
import { FEE_RULES } from '../fees/fees.js';
import { paystack } from '../orders/index.js';
import { createRegistrationFeeService } from './registrationFee.service.js';

// FEE_RULES is the same live object the admin's Pricing & rules page edits, so a new fee applies to the next payment.
export const registrationFee = createRegistrationFeeService({
  vendorsRepo,
  paystack,
  rules: FEE_RULES,
  config: { required: VENDOR_REGISTRATION_FEE_REQUIRED, callbackUrl: `${env.clientOrigin.replace(/\/$/, '')}/vendor/fee/return` },
});
