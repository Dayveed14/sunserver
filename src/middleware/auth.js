import { HttpError } from '../lib/httpError.js';
import { SESSION_COOKIE, verifySession } from '../lib/tokens.js';
import { toPublicUser } from '../lib/publicUser.js';
import { usersRepo } from '../repos/users.js';

const unauthorized = () => new HttpError(401, 'UNAUTHENTICATED', 'Please log in to continue.');

// Reads the session cookie, checks it against the database (so suspended users and revoked
// sessions stop working immediately), and exposes the user as req.user.
export async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw unauthorized();

    let claims;
    try {
      claims = verifySession(token);
    } catch {
      throw unauthorized();
    }

    const user = await usersRepo.findById(claims.sub);
    if (
      !user ||
      user.status !== 'active' ||
      !user.email_verified_at ||
      user.token_version !== claims.tv
    ) {
      throw unauthorized();
    }

    req.user = toPublicUser(user);
    next();
  } catch (err) {
    next(err);
  }
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new HttpError(403, 'FORBIDDEN', 'Your account type cannot do this.'));
  }
  next();
};
