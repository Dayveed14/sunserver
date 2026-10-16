import { query } from '../db/pool.js';

export const otpsRepo = {
  async create({ userId, purpose, codeHash, expiresAt, createdAt }) {
    const res = await query(
      'INSERT INTO email_otps (user_id, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, purpose, codeHash, expiresAt, createdAt]
    );
    return res.insertId;
  },

  async latestActive(userId, purpose) {
    const rows = await query(
      `SELECT id, code_hash, expires_at, attempts, created_at FROM email_otps
       WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`,
      [userId, purpose]
    );
    return rows[0] ?? null;
  },

  async latest(userId, purpose) {
    const rows = await query(
      'SELECT id, created_at FROM email_otps WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
      [userId, purpose]
    );
    return rows[0] ?? null;
  },

  async countSince(userId, purpose, since) {
    const rows = await query(
      'SELECT COUNT(*) AS n FROM email_otps WHERE user_id = ? AND purpose = ? AND created_at >= ?',
      [userId, purpose, since]
    );
    return Number(rows[0].n);
  },

  async incrementAttempts(id) {
    await query('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?', [id]);
  },

  async consume(id, at) {
    await query('UPDATE email_otps SET consumed_at = ? WHERE id = ?', [at, id]);
  },

  async consumeAllActive(userId, purpose, at) {
    await query(
      'UPDATE email_otps SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL',
      [at, userId, purpose]
    );
  },

  async remove(id) {
    await query('DELETE FROM email_otps WHERE id = ?', [id]);
  },
};
