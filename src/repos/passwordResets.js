import { query } from '../db/pool.js';

export const passwordResetsRepo = {
  async create({ userId, tokenHash, expiresAt, createdAt }) {
    const res = await query(
      'INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [userId, tokenHash, expiresAt, createdAt]
    );
    return res.insertId;
  },

  // A link that is unused and not yet expired.
  async findValid(tokenHash, at) {
    const rows = await query(
      'SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? LIMIT 1',
      [tokenHash, at]
    );
    return rows[0] ? { id: Number(rows[0].id), userId: Number(rows[0].user_id) } : null;
  },

  async latestFor(userId) {
    const rows = await query('SELECT created_at FROM password_resets WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    return rows[0] ?? null;
  },

  async countSince(userId, since) {
    const rows = await query('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at >= ?', [userId, since]);
    return Number(rows[0].n);
  },

  async consumeAllFor(userId, at) {
    await query('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [at, userId]);
  },

  async remove(id) {
    await query('DELETE FROM password_resets WHERE id = ?', [id]);
  },
};
