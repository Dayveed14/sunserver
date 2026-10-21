import { query, withTransaction } from '../db/pool.js';
import { HttpError } from '../lib/httpError.js';

const SELECT_USER = `
  SELECT u.id, u.email, u.password_hash, u.role, u.full_name, u.phone, u.email_verified_at,
         u.status, u.token_version, u.failed_login_attempts, u.locked_until,
         COALESCE(b.company_name, v.company_name) AS company_name,
         a.address_line, a.state AS address_state, a.area_id AS address_area
  FROM users u
  LEFT JOIN business_profiles b ON b.user_id = u.id
  LEFT JOIN vendor_profiles v ON v.user_id = u.id
  LEFT JOIN addresses a ON a.user_id = u.id`;

const ROLE_ORDER = { admin: 0, individual: 1, business: 2, vendor: 3 };
const byRole = (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role];

async function writeAddress(conn, userId, address) {
  if (!address) return;
  await conn.execute(
    `INSERT INTO addresses (user_id, address_line, state, area_id) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE address_line = VALUES(address_line), state = VALUES(state), area_id = VALUES(area_id)`,
    [userId, address.line, address.state, address.areaId]
  );
}

async function insertProfile(conn, userId, role, companyName, feeStatus = 'waived') {
  if (role === 'individual') {
    await conn.execute('INSERT INTO individual_profiles (user_id) VALUES (?)', [userId]);
  } else if (role === 'business') {
    await conn.execute('INSERT INTO business_profiles (user_id, company_name) VALUES (?, ?)', [userId, companyName]);
  } else if (role === 'vendor') {
    await conn.execute('INSERT INTO vendor_profiles (user_id, company_name, registration_fee_status) VALUES (?, ?, ?)', [userId, companyName, feeStatus]);
  }
}

export const usersModel = {
  // Every account that shares this email (at most one per account type).
  async listByEmail(email) {
    const rows = await query(`${SELECT_USER} WHERE u.email = ?`, [email]);
    return rows.sort(byRole);
  },

  async findByEmailRole(email, role) {
    const rows = await query(`${SELECT_USER} WHERE u.email = ? AND u.role = ? LIMIT 1`, [email, role]);
    return rows[0] ?? null;
  },

  async findById(id) {
    const rows = await query(`${SELECT_USER} WHERE u.id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  },

  // `verifiedAt` is set when the person has already proved this email (they hold another account on it).
  async create({ email, passwordHash, role, fullName, phone, companyName, address, verifiedAt, registrationFeeStatus }) {
    try {
      return await withTransaction(async (conn) => {
        const [res] = await conn.execute(
          'INSERT INTO users (email, password_hash, role, full_name, phone, email_verified_at) VALUES (?, ?, ?, ?, ?, ?)',
          [email, passwordHash, role, fullName, phone ?? null, verifiedAt ?? null]
        );
        await insertProfile(conn, res.insertId, role, companyName, registrationFeeStatus);
        await writeAddress(conn, res.insertId, address);
        return res.insertId;
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new HttpError(409, 'EMAIL_TAKEN', 'You already have this type of account with this email. Log in instead.');
      }
      throw err;
    }
  },

  // Someone who started signing up but never verified may come back and register again.
  async updatePendingRegistration(id, { passwordHash, role, fullName, phone, companyName, address, registrationFeeStatus }) {
    await withTransaction(async (conn) => {
      await conn.execute('DELETE FROM individual_profiles WHERE user_id = ?', [id]);
      await conn.execute('DELETE FROM business_profiles WHERE user_id = ?', [id]);
      await conn.execute('DELETE FROM vendor_profiles WHERE user_id = ?', [id]);
      await conn.execute(
        'UPDATE users SET password_hash = ?, role = ?, full_name = ?, phone = ? WHERE id = ?',
        [passwordHash, role, fullName, phone ?? null, id]
      );
      await insertProfile(conn, id, role, companyName, registrationFeeStatus);
      await writeAddress(conn, id, address);
    });
  },

  async markEmailVerified(id, at) {
    await query('UPDATE users SET email_verified_at = ? WHERE id = ?', [at, id]);
  },

  async setLoginFailures(id, { attempts, lockedUntil }) {
    await query('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?', [
      attempts,
      lockedUntil ?? null,
      id,
    ]);
  },

  async resetLoginFailures(id) {
    await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [id]);
  },

  async bumpTokenVersion(id) {
    await query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [id]);
  },

  // Accounts that share an email share a password, and a lockout covers them all.
  async setLoginFailuresForEmail(email, { attempts, lockedUntil }) {
    await query('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE email = ?', [attempts, lockedUntil ?? null, email]);
  },

  async resetLoginFailuresForEmail(email) {
    await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE email = ?', [email]);
  },

  // New password for every account on this email: all existing sessions stop working and any lockout is cleared.
  async setPasswordForEmail(email, passwordHash) {
    await query(
      `UPDATE users SET password_hash = ?, token_version = token_version + 1,
       failed_login_attempts = 0, locked_until = NULL WHERE email = ?`,
      [passwordHash, email]
    );
  },

  async updateContact(id, { fullName, phone, address }) {
    await withTransaction(async (conn) => {
      await conn.execute('UPDATE users SET full_name = ?, phone = ? WHERE id = ?', [fullName, phone, id]);
      await writeAddress(conn, id, address);
    });
  },

  async setStatus(id, status) {
    await query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  },

  async listForAdmin({ q, role, limit = 100 }) {
    const where = [];
    const params = [];
    if (role) { where.push('u.role = ?'); params.push(role); }
    if (q) { where.push('(u.email LIKE ? OR u.full_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const rows = await query(
      `${SELECT_USER} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY u.id DESC LIMIT ${Number(limit) | 0}`,
      params
    );
    return rows.map((r) => ({
      id: Number(r.id), email: r.email, fullName: r.full_name, role: r.role, status: r.status,
      companyName: r.company_name ?? null, emailVerified: Boolean(r.email_verified_at),
    }));
  },
};
