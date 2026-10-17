import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { HttpError } from '../../lib/httpError.js';
import { toPublicUser } from '../../lib/publicUser.js';

const PURPOSE = 'verify_email';
// Compared against when an email doesn't exist, so response time doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('sunledger-timing-equaliser', 10);

export function createAuthService({ users, otps, resets, mailer, config, now = () => new Date() }) {
  const { otp: otpCfg, login: loginCfg } = config;
  const resetCfg = config.reset ?? { ttlMinutes: 60, cooldownSeconds: 60, maxPerHour: 5 };
  const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

  const hashCode = (code) => crypto.createHmac('sha256', config.otpSecret).update(code).digest('hex');
  const hashesMatch = (a, b) => {
    const x = Buffer.from(a, 'hex');
    const y = Buffer.from(b, 'hex');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const invalidCredentials = () =>
    new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

  async function sendOtp(user) {
    const t = now();

    const last = await otps.latest(user.id, PURPOSE);
    if (last) {
      const waitMs = new Date(last.created_at).getTime() + otpCfg.resendCooldownSeconds * 1000 - t.getTime();
      if (waitMs > 0) {
        const seconds = Math.ceil(waitMs / 1000);
        throw new HttpError(429, 'OTP_COOLDOWN', `Please wait ${seconds} seconds before requesting another code.`, {
          retryAfterSeconds: seconds,
        });
      }
    }

    const sentLastHour = await otps.countSince(user.id, PURPOSE, new Date(t.getTime() - 60 * 60 * 1000));
    if (sentLastHour >= otpCfg.maxSendsPerHour) {
      throw new HttpError(429, 'OTP_LIMIT', 'Too many codes requested. Please try again in a while.');
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await otps.consumeAllActive(user.id, PURPOSE, t);
    const otpId = await otps.create({
      userId: user.id,
      purpose: PURPOSE,
      codeHash: hashCode(code),
      expiresAt: new Date(t.getTime() + otpCfg.ttlMinutes * 60 * 1000),
      createdAt: t,
    });

    try {
      await mailer.sendOtp({ to: user.email, name: user.full_name, code, ttlMinutes: otpCfg.ttlMinutes });
    } catch (err) {
      await otps.remove(otpId); // a code the user never received shouldn't count against them
      console.error('[auth] verification email failed:', err.message);
      throw new HttpError(502, 'MAIL_FAILED', 'We could not send the verification email. Please try again.');
    }
    return { resendInSeconds: otpCfg.resendCooldownSeconds };
  }

  async function register({ email, password, role, fullName, phone, companyName }) {
    const existing = await users.findByEmail(email);
    if (existing?.email_verified_at) {
      throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Log in instead.');
    }

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    let user;
    if (existing) {
      await users.updatePendingRegistration(existing.id, { passwordHash, role, fullName, phone, companyName });
      user = { ...existing, role, full_name: fullName };
    } else {
      const id = await users.create({ email, passwordHash, role, fullName, phone, companyName });
      user = { id, email, role, full_name: fullName };
    }

    const { resendInSeconds } = await sendOtp(user);
    return { email, resendInSeconds };
  }

  async function verifyEmail({ email, code }) {
    const t = now();
    const user = await users.findByEmail(email);
    if (!user) throw new HttpError(400, 'INVALID_CODE', 'That code is not valid.');
    if (user.email_verified_at) {
      throw new HttpError(409, 'ALREADY_VERIFIED', 'This email is already verified. Please log in.');
    }

    const otp = await otps.latestActive(user.id, PURPOSE);
    if (!otp || new Date(otp.expires_at) <= t) {
      throw new HttpError(400, 'CODE_EXPIRED', 'This code has expired. Request a new one.');
    }
    if (otp.attempts >= otpCfg.maxAttempts) {
      throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Request a new code.');
    }

    if (!hashesMatch(hashCode(code), otp.code_hash)) {
      await otps.incrementAttempts(otp.id);
      const left = otpCfg.maxAttempts - (otp.attempts + 1);
      throw new HttpError(
        400,
        'INVALID_CODE',
        left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.` : 'That code isn\'t right. Request a new code.',
        { attemptsLeft: left }
      );
    }

    await otps.consume(otp.id, t);
    await users.markEmailVerified(user.id, t);
    return toPublicUser({ ...user, email_verified_at: t });
  }

  async function resendOtp({ email }) {
    const user = await users.findByEmail(email);
    // Unknown or already-verified emails get the same answer as a successful send.
    if (!user || user.email_verified_at) return { resendInSeconds: otpCfg.resendCooldownSeconds };
    return sendOtp(user);
  }

  async function login({ email, password }) {
    const t = now();
    const user = await users.findByEmail(email);
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      throw invalidCredentials();
    }

    if (user.locked_until && new Date(user.locked_until) > t) {
      const seconds = Math.ceil((new Date(user.locked_until).getTime() - t.getTime()) / 1000);
      throw new HttpError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Please try again in a few minutes.', {
        retryAfterSeconds: seconds,
      });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      const attempts = (user.failed_login_attempts ?? 0) + 1;
      if (attempts >= loginCfg.maxFailures) {
        await users.setLoginFailures(user.id, {
          attempts: 0,
          lockedUntil: new Date(t.getTime() + loginCfg.lockMinutes * 60 * 1000),
        });
      } else {
        await users.setLoginFailures(user.id, { attempts, lockedUntil: null });
      }
      throw invalidCredentials();
    }

    if (user.status !== 'active') {
      throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended. Contact support.');
    }

    if (!user.email_verified_at) {
      // Right password but never verified: send a fresh code (best effort) and point them to the verify screen.
      try {
        await sendOtp(user);
      } catch (err) {
        console.warn('[auth] could not resend OTP during login:', err.code ?? err.message);
      }
      throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email to continue.', { email: user.email });
    }

    if (user.failed_login_attempts > 0 || user.locked_until) await users.resetLoginFailures(user.id);
    return toPublicUser(user);
  }

  // Always answers the same way, so nobody can use this form to find out which emails have accounts.
  async function forgotPassword({ email }) {
    const t = now();
    const user = await users.findByEmail(email);
    if (!user || !user.email_verified_at || user.status !== 'active') return { ok: true };

    const last = await resets.latestFor(user.id);
    if (last && new Date(last.created_at).getTime() + resetCfg.cooldownSeconds * 1000 > t.getTime()) return { ok: true };
    if ((await resets.countSince(user.id, new Date(t.getTime() - 60 * 60 * 1000))) >= resetCfg.maxPerHour) return { ok: true };

    const token = crypto.randomBytes(32).toString('base64url');
    const id = await resets.create({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(t.getTime() + resetCfg.ttlMinutes * 60 * 1000),
      createdAt: t,
    });
    try {
      await mailer.sendPasswordReset({
        to: user.email,
        name: user.full_name,
        link: config.resetLink(token),
        ttlMinutes: resetCfg.ttlMinutes,
      });
    } catch (err) {
      await resets.remove(id);
      console.error('[auth] password reset email failed:', err.message);
    }
    return { ok: true };
  }

  async function resetPassword({ token, password }) {
    const t = now();
    const invalid = () => new HttpError(400, 'INVALID_RESET', 'This reset link is invalid or has expired. Request a new one.');
    const row = await resets.findValid(sha256(token), t);
    if (!row) throw invalid();
    const user = await users.findById(row.userId);
    if (!user || user.status !== 'active') throw invalid();

    await users.setPassword(user.id, await bcrypt.hash(password, config.bcryptRounds));
    await resets.consumeAllFor(user.id, t); // this link and any older ones are now dead
    return { ok: true };
  }

  return { register, verifyEmail, resendOtp, login, forgotPassword, resetPassword };
}
