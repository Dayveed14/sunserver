import { HttpError } from '../lib/httpError.js';
import { installersModel } from '../models/installers.js';

// Installers see and take jobs only after the admin has approved them.
export async function requireVerifiedInstaller(req, res, next) {
  try {
    const p = await installersModel.getProfile(req.user.id);
    if (p?.verification !== 'verified') {
      throw new HttpError(403, 'INSTALLER_NOT_VERIFIED', 'You will receive jobs once our team has approved you.');
    }
    next();
  } catch (err) {
    next(err);
  }
}
