import { HttpError } from '../lib/httpError.js';
import { registrationFeeService } from '../services/index.js';
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
