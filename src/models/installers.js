import { query } from '../db/pool.js';

export const installersModel = {
  async getProfile(userId) {
    const rows = await query(
      `SELECT i.user_id, i.years_experience, i.verification_status, i.verification_note, i.quiz_submitted_at, i.verified_at,
              u.email, u.full_name, u.phone, u.status AS account_status, a.state, a.area_id
       FROM installer_profiles i JOIN users u ON u.id = i.user_id LEFT JOIN addresses a ON a.user_id = u.id WHERE i.user_id = ? LIMIT 1`,
      [userId]
    );
    return rows[0] ? toProfile(rows[0]) : null;
  },

  async listForAdmin({ status } = {}) {
    const rows = await query(
      `SELECT i.user_id, i.years_experience, i.verification_status, i.verification_note, i.quiz_submitted_at, i.verified_at,
              u.email, u.full_name, u.phone, u.status AS account_status, a.state, a.area_id,
              (SELECT q.score FROM installer_quiz_attempts q WHERE q.user_id = i.user_id ORDER BY q.id DESC LIMIT 1) AS score,
              (SELECT q.total FROM installer_quiz_attempts q WHERE q.user_id = i.user_id ORDER BY q.id DESC LIMIT 1) AS total
       FROM installer_profiles i JOIN users u ON u.id = i.user_id LEFT JOIN addresses a ON a.user_id = u.id
       ${status ? 'WHERE i.verification_status = ?' : ''}
       ORDER BY (i.verification_status = 'pending' AND i.quiz_submitted_at IS NOT NULL) DESC, i.created_at DESC LIMIT 200`,
      status ? [status] : []
    );
    return rows.map((r) => ({ ...toProfile(r), score: r.score == null ? null : Number(r.score), total: r.total == null ? null : Number(r.total) }));
  },

  async setVerification(userId, status, note = null) {
    const res = await query(
      `UPDATE installer_profiles SET verification_status = ?, verification_note = ?, verified_at = ${status === 'verified' ? 'UTC_TIMESTAMP()' : 'NULL'} WHERE user_id = ?`,
      [status, status === 'verified' ? null : note, userId]
    );
    return res.affectedRows > 0;
  },

  async setExperience(userId, years) {
    await query('UPDATE installer_profiles SET years_experience = ? WHERE user_id = ?', [years, userId]);
  },

  // ---- the technical questions ----
  async saveAttempt({ userId, answers, score, total }) {
    await query('INSERT INTO installer_quiz_attempts (user_id, answers, score, total) VALUES (?, ?, ?, ?)', [userId, JSON.stringify(answers), score, total]);
    // A fresh submission goes back to "waiting for the admin", even after a decline.
    await query("UPDATE installer_profiles SET quiz_submitted_at = UTC_TIMESTAMP(), verification_status = 'pending', verification_note = NULL WHERE user_id = ? AND verification_status <> 'verified'", [userId]);
  },
  async latestAttempt(userId) {
    const rows = await query('SELECT id, answers, score, total, created_at FROM installer_quiz_attempts WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    const r = rows[0];
    if (!r) return null;
    return { id: Number(r.id), answers: typeof r.answers === 'string' ? JSON.parse(r.answers) : r.answers, score: Number(r.score), total: Number(r.total), createdAt: r.created_at };
  },
  async attemptCount(userId) {
    const rows = await query('SELECT COUNT(*) AS n FROM installer_quiz_attempts WHERE user_id = ?', [userId]);
    return Number(rows[0].n);
  },
};

const toProfile = (r) => ({
  userId: Number(r.user_id), email: r.email, fullName: r.full_name, phone: r.phone, accountStatus: r.account_status,
  state: r.state ?? null, areaId: r.area_id ?? null, yearsExperience: r.years_experience ?? null,
  verification: r.verification_status, note: r.verification_note, quizSubmittedAt: r.quiz_submitted_at, verifiedAt: r.verified_at,
});
