import { HttpError } from '../lib/httpError.js';
import { registrationFeeService, subscriptionService } from '../services/index.js';
import { vendorsModel } from '../models/vendors.js';

// While registration is paid, a vendor who has not paid can sign in but cannot use the dashboard.
// When registration is free this lets everyone through.
export async function requireVendorActive(req, res, next) {
  try {
    if (!(await registrationFeeService.isActive(req.user.id))) {
      throw new HttpError(402, 'REGISTRATION_FEE_REQUIRED', 'Pay the one-time registration fee to start selling on Solalium.');
    }
    next();
  } catch (err) {
    next(err);
  }
}

// A vendor must be approved by the admin before they can post products or deals. Until then they can sign in,
// send their documents and see where their application stands.
export async function requireVerifiedVendor(req, res, next) {
  try {
    const p = await vendorsModel.getProfile(req.user.id);
    if (p?.verification !== 'verified') {
      throw new HttpError(403, 'VENDOR_NOT_VERIFIED', p?.verification === 'rejected'
        ? 'Your verification was not approved. Open Verification to see why and send new documents.'
        : 'Your account is waiting for verification. Upload your documents and we will review them before you can post products.');
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Posting products and deals needs the monthly subscription to be paid (or inside its grace period) when the vendor's type has one.
// Reading, order handling and everything the vendor already owes customers stays open.
export async function requireSubscription(req, res, next) {
  try {
    if (!(await subscriptionService.isActive(req.user.id))) {
      throw new HttpError(402, 'SUBSCRIPTION_REQUIRED', 'Your monthly subscription has ended. Renew it to add or change products and deals.');
    }
    next();
  } catch (err) {
    next(err);
  }
}
