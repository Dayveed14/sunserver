import { query, withTransaction } from '../db/pool.js';
import { HttpError } from '../lib/httpError.js';

const SELECT_USER = `
  SELECT u.id, u.email, u.password_hash, u.role, u.full_name, u.phone, u.email_verified_at,
         u.status, u.token_version, u.failed_login_attempts, u.locked_until,
         COALESCE(b.company_name, v.company_name) AS company_name
  FROM users u
  LEFT JOIN business_profiles b ON b.user_id = u.id
  LEFT JOIN vendor_profiles v ON v.user_id = u.id`;

async function insertProfile(conn, userId, role, companyName) {
  if (role === 'individual') {
    await conn.execute('INSERT INTO individual_profiles (user_id) VALUES (?)', [userId]);
  } else if (role === 'business') {
    await conn.execute('INSERT INTO business_profiles (user_id, company_name) VALUES (?, ?)', [userId, companyName]);
  } else if (role === 'vendor') {
    await conn.execute('INSERT INTO vendor_profiles (user_id, company_name) VALUES (?, ?)', [userId, companyName]);
  }
}

export const usersRepo = {
  async findByEmail(email) {
    const rows = await query(`${SELECT_USER} WHERE u.email = ? LIMIT 1`, [email]);
    return rows[0] ?? null;
  },

  async findById(id) {
    const rows = await query(`${SELECT_USER} WHERE u.id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  },

  async create({ email, passwordHash, role, fullName, phone, companyName }) {
    try {
      return await withTransaction(async (conn) => {
        const [res] = await conn.execute(
          'INSERT INTO users (email, password_hash, role, full_name, phone) VALUES (?, ?, ?, ?, ?)',
          [email, passwordHash, role, fullName, phone ?? null]
        );
        await insertProfile(conn, res.insertId, role, companyName);
        return res.insertId;
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Log in instead.');
      }
      throw err;
    }
  },

  // Someone who started signing up but never verified may come back and register again.
  async updatePendingRegistration(id, { passwordHash, role, fullName, phone, companyName }) {
    await withTransaction(async (conn) => {
      await conn.execute('DELETE FROM individual_profiles WHERE user_id = ?', [id]);
      await conn.execute('DELETE FROM business_profiles WHERE user_id = ?', [id]);
      await conn.execute('DELETE FROM vendor_profiles WHERE user_id = ?', [id]);
      await conn.execute(
        'UPDATE users SET password_hash = ?, role = ?, full_name = ?, phone = ? WHERE id = ?',
        [passwordHash, role, fullName, phone ?? null, id]
      );
      await insertProfile(conn, id, role, companyName);
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
};
