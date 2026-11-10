import { query } from '../db/pool.js';

// What an installer tells us when they register, and the people who vouch for them.
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

const toRegistration = (r) => ({
  userId: Number(r.user_id),
  flowVersion: Number(r.flow_version),
  registrationSubmittedAt: r.registration_submitted_at ?? null,
  verification: r.verification_status,
  verificationNote: r.verification_note ?? null,
  quizSubmittedAt: r.quiz_submitted_at ?? null,
  businessStatus: r.business_status ?? null,
  travelKm: r.travel_km == null ? null : Number(r.travel_km),
  experienceBand: r.experience_band ?? null,
  qualification: r.qualification ?? null,
  about: r.about ?? null,
  projectTypes: r.project_types ? parse(r.project_types) : [],
  capacity: r.capacity == null ? null : Number(r.capacity),
  responseTime: r.response_time ?? null,
  acceptsRepairs: Boolean(r.accepts_repairs),
});

const toReference = (r) => ({
  id: Number(r.id), name: r.name, phone: r.phone, relationship: r.relationship,
  calledAt: r.called_at ?? null, callNote: r.call_note ?? null,
});

// Request field -> column. Only these can be written, so a request can never touch any other column.
const COLUMNS = {
  businessStatus: 'business_status', travelKm: 'travel_km', experienceBand: 'experience_band', qualification: 'qualification',
  about: 'about', projectTypes: 'project_types', capacity: 'capacity', responseTime: 'response_time', acceptsRepairs: 'accepts_repairs',
};

export const installerRegistrationModel = {
  async get(userId) {
    const rows = await query('SELECT * FROM installer_profiles WHERE user_id = ? LIMIT 1', [userId]);
    return rows[0] ? toRegistration(rows[0]) : null;
  },

  async save(userId, patch, years = null) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = ?`);
      const v = patch[key];
      values.push(key === 'projectTypes' ? JSON.stringify(v) : key === 'acceptsRepairs' ? (v ? 1 : 0) : key === 'about' ? (v || null) : v);
    }
    if (years != null) { sets.push('years_experience = ?'); values.push(years); }
    if (sets.length === 0) return;
    await query(`UPDATE installer_profiles SET ${sets.join(', ')} WHERE user_id = ?`, [...values, userId]);
  },

  // Sent for review. A declined installer who fixes things and sends again goes back to "waiting".
  async markSubmitted(userId) {
    await query(
      "UPDATE installer_profiles SET registration_submitted_at = UTC_TIMESTAMP(), flow_version = 2, verification_status = 'pending', verification_note = NULL WHERE user_id = ? AND verification_status <> 'verified'",
      [userId]
    );
  },

  async listReferences(userId) {
    const rows = await query('SELECT id, name, phone, relationship, called_at, call_note FROM installer_references WHERE user_id = ? ORDER BY id', [userId]);
    return rows.map(toReference);
  },

  // The whole list is replaced together. Checked-off calls are kept for a person whose name and number did not change.
  async replaceReferences(userId, refs) {
    const old = await this.listReferences(userId);
    await query('DELETE FROM installer_references WHERE user_id = ?', [userId]);
    for (const r of refs) {
      const same = old.find((o) => o.name === r.name && o.phone === r.phone);
      await query(
        'INSERT INTO installer_references (user_id, name, phone, relationship, called_at, call_note) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, r.name, r.phone, r.relationship, same?.calledAt ?? null, same?.callNote ?? null]
      );
    }
  },

  async markCalled(userId, refId, adminId, called, note) {
    const res = await query(
      `UPDATE installer_references SET called_at = ${called ? 'UTC_TIMESTAMP()' : 'NULL'}, called_by = ${called ? '?' : 'NULL'}, call_note = ? WHERE id = ? AND user_id = ?`,
      called ? [adminId, note || null, refId, userId] : [note || null, refId, userId]
    );
    return res.affectedRows > 0;
  },
};
