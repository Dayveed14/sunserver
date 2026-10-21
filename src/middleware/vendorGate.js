import { HttpError } from '../lib/httpError.js';
import { registrationFee } from '../modules/vendors/index.js';

// While registration is paid, a vendor who has not paid can sign in but cannot use the dashboard.
// When registration is free this lets everyone through.
export async function requireVendorActive(req, res, next) {
  try {
    if (!(await registrationFee.isActive(req.user.id))) {
      throw new HttpError(402, 'REGISTRATION_FEE_REQUIRED', 'Pay the one-time registration fee to start selling on Sunledger.');
    }
    next();
  } catch (err) {
    next(err);
  }
}
