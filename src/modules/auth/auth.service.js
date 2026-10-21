import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { HttpError } from '../../lib/httpError.js';
import { toPublicUser } from '../../lib/publicUser.js';

const PURPOSE = 'verify_email';
// Compared against when an email doesn't exist, so response time doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('sunledger-timing-equaliser', 10);

const ROLE_LABEL = { individual: 'individual', business: 'business', vendor: 'vendor', admin: 'admin' };
// If a person has several accounts on one email, log in to the first of these they have.
const LOGIN_PRIORITY = ['admin', 'individual', 'business', 'vendor'];
const byPriority = (a, b) => LOGIN_PRIORITY.indexOf(a.role) - LOGIN_PRIORITY.indexOf(b.role);

export function createAuthService({ users, otps, resets, mailer, config, now = () => new Date(), onAccountCreated = async () => {} }) {
  // New vendors pay the registration fee only when registration is switched to paid (config/launch.js).
  const feeStatusFor = (role) => (role === 'vendor' && config.vendorRegistrationFeeRequired ? 'unpaid' : 'waived');

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

  async function register({ email, password, role, fullName, phone, companyName, address }) {
    const accounts = await users.listByEmail(email);
    const same = accounts.find((u) => u.role === role);
    if (same?.email_verified_at) {
      throw new HttpError(409, 'EMAIL_TAKEN', `You already have ${ROLE_LABEL[role] === 'individual' ? 'an' : 'a'} ${ROLE_LABEL[role]} account with this email. Log in instead.`);
    }

    // The email already belongs to someone: they can open another type of account, but must prove it is theirs
    // with the password of the account they already have. No code needed, since the email is already verified.
    const verifiedOthers = accounts.filter((u) => u.email_verified_at && u.role !== role && u.role !== 'admin');
    if (verifiedOthers.length) {
      const owner = verifiedOthers[0];
      if (!(await bcrypt.compare(password, owner.password_hash))) {
        throw new HttpError(401, 'EXISTING_ACCOUNT_PASSWORD',
          `This email already has a Sunledger account. To add a ${ROLE_LABEL[role]} account, enter that account's current password.`);
      }
      const t = now();
      const id = await users.create({ email, passwordHash: owner.password_hash, role, fullName, phone, companyName, address, verifiedAt: t, registrationFeeStatus: feeStatusFor(role) });
      const created = await users.findById(id);
      await onAccountCreated(created);
      return { email, added: true, user: toPublicUser(created), userId: id };
    }

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    let user;
    if (same) {
      await users.updatePendingRegistration(same.id, { passwordHash, role, fullName, phone, companyName, address, registrationFeeStatus: feeStatusFor(role) });
      user = { ...same, role, full_name: fullName };
    } else {
      const id = await users.create({ email, passwordHash, role, fullName, phone, companyName, address, registrationFeeStatus: feeStatusFor(role) });
      user = { id, email, role, full_name: fullName };
    }

    const { resendInSeconds } = await sendOtp(user);
    return { email, role, resendInSeconds };
  }

  // The unverified account this email is waiting on (the one for `role`, or the newest unverified one).
  async function pendingAccount(email, role) {
    const accounts = await users.listByEmail(email);
    if (role) return accounts.find((u) => u.role === role) ?? null;
    return accounts.filter((u) => !u.email_verified_at).sort((x, y) => Number(y.id) - Number(x.id))[0] ?? accounts[0] ?? null;
  }

  async function verifyEmail({ email, code, role }) {
    const t = now();
    const user = await pendingAccount(email, role);
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
    const verified = await users.findById(user.id);
    await onAccountCreated(verified);
    return toPublicUser(verified);
  }

  async function resendOtp({ email, role }) {
    const user = await pendingAccount(email, role);
    // Unknown or already-verified emails get the same answer as a successful send.
    if (!user || user.email_verified_at) return { resendInSeconds: otpCfg.resendCooldownSeconds };
    return sendOtp(user);
  }

  async function login({ email, password, role }) {
    const t = now();
    const accounts = (await users.listByEmail(email)).filter((u) => u.role !== undefined);
    if (!accounts.length) {
      await bcrypt.compare(password, DUMMY_HASH);
      throw invalidCredentials();
    }

    const lockedUntil = accounts.map((u) => u.locked_until).filter(Boolean).map((d) => new Date(d)).sort((x, y) => y - x)[0];
    if (lockedUntil && lockedUntil > t) {
      const seconds = Math.ceil((lockedUntil.getTime() - t.getTime()) / 1000);
      throw new HttpError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Please try again in a few minutes.', {
        retryAfterSeconds: seconds,
      });
    }

    const matches = [];
    for (const u of accounts) if (await bcrypt.compare(password, u.password_hash)) matches.push(u);
    if (!matches.length) {
      const attempts = Math.max(...accounts.map((u) => u.failed_login_attempts ?? 0)) + 1;
      if (attempts >= loginCfg.maxFailures) {
        await users.setLoginFailuresForEmail(email, { attempts: 0, lockedUntil: new Date(t.getTime() + loginCfg.lockMinutes * 60 * 1000) });
      } else {
        await users.setLoginFailuresForEmail(email, { attempts, lockedUntil: null });
      }
      throw invalidCredentials();
    }

    const usable = matches.filter((u) => u.status === 'active' && u.email_verified_at);
    if (!usable.length) {
      if (matches.every((u) => u.status !== 'active')) {
        throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended. Contact support.');
      }
      const unverified = matches.find((u) => !u.email_verified_at);
      // Right password but never verified: send a fresh code (best effort) and point them to the verify screen.
      try {
        await sendOtp(unverified);
      } catch (err) {
        console.warn('[auth] could not resend OTP during login:', err.code ?? err.message);
      }
      throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email to continue.', { email: unverified.email, role: unverified.role });
    }

    const chosen = (role && usable.find((u) => u.role === role)) || [...usable].sort(byPriority)[0];
    if (accounts.some((u) => u.failed_login_attempts > 0 || u.locked_until)) await users.resetLoginFailuresForEmail(email);
    return toPublicUser(chosen);
  }

  // Move between the accounts that share the signed-in person's email (their individual, business and vendor accounts).
  async function switchAccount(currentUserId, role) {
    const current = await users.findById(currentUserId);
    if (!current) throw new HttpError(401, 'UNAUTHENTICATED', 'Please log in to continue.');
    const target = (await users.listByEmail(current.email)).find((u) => u.role === role && u.role !== 'admin');
    if (!target || !target.email_verified_at || target.status !== 'active') {
      throw new HttpError(404, 'NOT_FOUND', 'You do not have that type of account yet.');
    }
    return toPublicUser(target);
  }

  // A signed-in person opens another type of account on the same email. They are already authenticated,
  // so it uses their current password and needs no code.
  async function addAccount(currentUserId, { role, fullName, phone, companyName, address }) {
    const current = await users.findById(currentUserId);
    if (!current) throw new HttpError(401, 'UNAUTHENTICATED', 'Please log in to continue.');
    const accounts = await users.listByEmail(current.email);
    if (accounts.some((u) => u.role === role)) {
      throw new HttpError(409, 'EMAIL_TAKEN', `You already have ${role === 'individual' ? 'an' : 'a'} ${role} account.`);
    }
    const id = await users.create({
      email: current.email, passwordHash: current.password_hash, role,
      fullName: fullName ?? current.full_name, phone: phone ?? current.phone, companyName, address, verifiedAt: now(),
      registrationFeeStatus: feeStatusFor(role),
    });
    const created = await users.findById(id);
    await onAccountCreated(created);
    return toPublicUser(created);
  }

  async function updateProfile(userId, { fullName, phone, address }) {
    await users.updateContact(userId, { fullName, phone, address });
    const updated = await users.findById(userId);
    await onAccountCreated(updated); // a vendor who moved needs their delivery prices worked out again
    return toPublicUser(updated);
  }

  // Always answers the same way, so nobody can use this form to find out which emails have accounts.
  async function forgotPassword({ email }) {
    const t = now();
    const user = (await users.listByEmail(email)).sort(byPriority).find((u) => u.email_verified_at && u.status === 'active');
    if (!user) return { ok: true };

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

    await users.setPasswordForEmail(user.email, await bcrypt.hash(password, config.bcryptRounds));
    await resets.consumeAllFor(user.id, t); // this link and any older ones are now dead
    return { ok: true };
  }

  return { register, verifyEmail, resendOtp, login, forgotPassword, resetPassword, switchAccount, addAccount, updateProfile };
}
