// In-memory stand-ins for the MySQL repositories, so the sign-up/login rules can be tested without a database.
import { HttpError } from '../src/lib/httpError.js';

export function createMemoryModels() {
  let nextUserId = 1;
  let nextOtpId = 1;
  const users = new Map();
  const otpRows = [];
  const copy = (row) => (row ? { ...row } : null);

  const usersModel = {
    async listByEmail(email) {
      const order = { admin: 0, individual: 1, business: 2, vendor: 3 };
      return [...users.values()].filter((u) => u.email === email).map(copy).sort((x, y) => order[x.role] - order[y.role]);
    },
    async findByEmailRole(email, role) {
      return copy([...users.values()].find((u) => u.email === email && u.role === role));
    },
    async findById(id) {
      return copy(users.get(Number(id)));
    },
    async create({ email, passwordHash, role, fullName, phone, companyName, address, verifiedAt }) {
      if ([...users.values()].some((u) => u.email === email && u.role === role)) {
        throw new HttpError(409, 'EMAIL_TAKEN', 'You already have this type of account with this email. Log in instead.');
      }
      const id = nextUserId++;
      users.set(id, {
        id, email, password_hash: passwordHash, role, full_name: fullName, phone: phone ?? null,
        company_name: companyName ?? null, email_verified_at: verifiedAt ?? null, status: 'active',
        token_version: 0, failed_login_attempts: 0, locked_until: null,
        address_line: address?.line ?? null, address_state: address?.state ?? null, address_area: address?.areaId ?? null,
      });
      return id;
    },
    async updatePendingRegistration(id, { passwordHash, role, fullName, phone, companyName, address }) {
      Object.assign(users.get(id), {
        password_hash: passwordHash, role, full_name: fullName, phone: phone ?? null, company_name: companyName ?? null,
        address_line: address?.line ?? null, address_state: address?.state ?? null, address_area: address?.areaId ?? null,
      });
    },
    async markEmailVerified(id, at) {
      users.get(id).email_verified_at = at;
    },
    async setLoginFailuresForEmail(email, { attempts, lockedUntil }) {
      for (const u of users.values()) if (u.email === email) Object.assign(u, { failed_login_attempts: attempts, locked_until: lockedUntil ?? null });
    },
    async resetLoginFailuresForEmail(email) {
      for (const u of users.values()) if (u.email === email) Object.assign(u, { failed_login_attempts: 0, locked_until: null });
    },
    async bumpTokenVersion(id) {
      users.get(id).token_version += 1;
    },
    async setPasswordForEmail(email, hash) {
      for (const u of users.values()) {
        if (u.email !== email) continue;
        Object.assign(u, { password_hash: hash, failed_login_attempts: 0, locked_until: null });
        u.token_version += 1;
      }
    },
    async updateContact(id, { fullName, phone, address }) {
      Object.assign(users.get(id), { full_name: fullName, phone, address_line: address.line, address_state: address.state, address_area: address.areaId });
    },
    async setStatus(id, status) {
      users.get(id).status = status;
    },
  };

  const otpsModel = {
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

  const resetRows = [];
  const resetsModel = {
    async create({ userId, tokenHash, expiresAt, createdAt }) {
      const id = resetRows.length + 1;
      resetRows.push({ id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, used_at: null, created_at: createdAt });
      return id;
    },
    async findValid(tokenHash, at) {
      const r = resetRows.find((x) => x.token_hash === tokenHash && !x.used_at && x.expires_at > at);
      return r ? { id: r.id, userId: r.user_id } : null;
    },
    async latestFor(userId) {
      return copy([...resetRows].reverse().find((x) => x.user_id === userId));
    },
    async countSince(userId, since) {
      return resetRows.filter((x) => x.user_id === userId && x.created_at >= since).length;
    },
    async consumeAllFor(userId, at) {
      for (const r of resetRows) if (r.user_id === userId && !r.used_at) r.used_at = at;
    },
    async remove(id) {
      const i = resetRows.findIndex((x) => x.id === id);
      if (i >= 0) resetRows.splice(i, 1);
    },
  };

  return { usersModel, otpsModel, resetsModel, users, otpRows, resetRows };
}
