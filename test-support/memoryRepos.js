// In-memory stand-ins for the MySQL repositories, so the sign-up/login rules can be tested without a database.
import { HttpError } from '../src/lib/httpError.js';

export function createMemoryRepos() {
  let nextUserId = 1;
  let nextOtpId = 1;
  const users = new Map();
  const otpRows = [];
  const copy = (row) => (row ? { ...row } : null);

  const usersRepo = {
    async findByEmail(email) {
      return copy([...users.values()].find((u) => u.email === email));
    },
    async findById(id) {
      return copy(users.get(Number(id)));
    },
    async create({ email, passwordHash, role, fullName, phone, companyName }) {
      if ([...users.values()].some((u) => u.email === email)) {
        throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Log in instead.');
      }
      const id = nextUserId++;
      users.set(id, {
        id, email, password_hash: passwordHash, role, full_name: fullName, phone: phone ?? null,
        company_name: companyName ?? null, email_verified_at: null, status: 'active',
        token_version: 0, failed_login_attempts: 0, locked_until: null,
      });
      return id;
    },
    async updatePendingRegistration(id, { passwordHash, role, fullName, phone, companyName }) {
      Object.assign(users.get(id), {
        password_hash: passwordHash, role, full_name: fullName, phone: phone ?? null, company_name: companyName ?? null,
      });
    },
    async markEmailVerified(id, at) {
      users.get(id).email_verified_at = at;
    },
    async setLoginFailures(id, { attempts, lockedUntil }) {
      Object.assign(users.get(id), { failed_login_attempts: attempts, locked_until: lockedUntil ?? null });
    },
    async resetLoginFailures(id) {
      Object.assign(users.get(id), { failed_login_attempts: 0, locked_until: null });
    },
    async bumpTokenVersion(id) {
      users.get(id).token_version += 1;
    },
  };

  const otpsRepo = {
    async create({ userId, purpose, codeHash, expiresAt, createdAt }) {
      const id = nextOtpId++;
      otpRows.push({ id, user_id: userId, purpose, code_hash: codeHash, expires_at: expiresAt, attempts: 0, consumed_at: null, created_at: createdAt });
      return id;
    },
    async latestActive(userId, purpose) {
      return copy([...otpRows].reverse().find((o) => o.user_id === userId && o.purpose === purpose && !o.consumed_at));
    },
    async latest(userId, purpose) {
      return copy([...otpRows].reverse().find((o) => o.user_id === userId && o.purpose === purpose));
    },
    async countSince(userId, purpose, since) {
      return otpRows.filter((o) => o.user_id === userId && o.purpose === purpose && o.created_at >= since).length;
    },
    async incrementAttempts(id) {
      otpRows.find((o) => o.id === id).attempts += 1;
    },
    async consume(id, at) {
      otpRows.find((o) => o.id === id).consumed_at = at;
    },
    async consumeAllActive(userId, purpose, at) {
      for (const o of otpRows) if (o.user_id === userId && o.purpose === purpose && !o.consumed_at) o.consumed_at = at;
    },
    async remove(id) {
      const i = otpRows.findIndex((o) => o.id === id);
      if (i >= 0) otpRows.splice(i, 1);
    },
  };

  return { usersRepo, otpsRepo, users, otpRows };
}
