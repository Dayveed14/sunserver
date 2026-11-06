import { query, withTransaction } from '../db/pool.js';

// MySQL returns JSON columns already parsed; MariaDB returns strings.
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);
const day = (d) => (d == null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

const toAudit = (r) => ({
  id: Number(r.id), ref: r.public_ref, businessId: Number(r.business_id), status: r.status,
  contactName: r.contact_name, contactPhone: r.contact_phone, state: r.state, areaId: r.area_id, addressLine: r.address_line,
  preferredDate: day(r.preferred_date), notes: r.notes ?? null,
  agentId: r.agent_id == null ? null : Number(r.agent_id),
  assignedAt: r.assigned_at, startedAt: r.started_at, completedAt: r.completed_at,
  version: Number(r.version), form: parseJson(r.form_json), result: parseJson(r.result_json),
  assessmentId: r.assessment_id == null ? null : Number(r.assessment_id),
  kwhPerDay: r.kwh_per_day == null ? null : Number(r.kwh_per_day), eaasEligible: r.eaas_eligible == null ? null : Boolean(r.eaas_eligible),
  reviewNote: r.review_note ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

const event = (conn, auditId, type, actor, note = null) =>
  conn.execute('INSERT INTO audit_events (audit_id, type, actor, note) VALUES (?, ?, ?, ?)', [auditId, type, actor, note]);

export const auditsModel = {
  async create(d) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(
        `INSERT INTO site_audits (public_ref, business_id, contact_name, contact_phone, state, area_id, address_line, preferred_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.ref, d.businessId, d.contactName, d.contactPhone, d.state, d.areaId, d.addressLine, d.preferredDate ?? null, d.notes ?? null]
      );
      await event(conn, res.insertId, 'requested', 'business');
      return res.insertId;
    });
  },
  async findByRef(ref) {
    const rows = await query('SELECT * FROM site_audits WHERE public_ref = ? LIMIT 1', [ref]);
    return rows[0] ? toAudit(rows[0]) : null;
  },
  async listForBusiness(businessId) {
    const rows = await query('SELECT * FROM site_audits WHERE business_id = ? ORDER BY id DESC LIMIT 100', [businessId]);
    return rows.map(toAudit);
  },
  async listForAgent(agentId) {
    const rows = await query(
      `SELECT a.*, b.full_name AS business_name FROM site_audits a JOIN users b ON b.id = a.business_id
       WHERE a.agent_id = ? ORDER BY FIELD(a.status, 'reopened', 'in_progress', 'assigned', 'completed'), a.id DESC LIMIT 200`, [agentId]
    );
    return rows.map((r) => ({ ...toAudit(r), businessName: r.business_name }));
  },
  async listForAdmin({ status, ref } = {}) {
    const rows = await query(
      `SELECT a.*, b.full_name AS business_name, COALESCE(bp.company_name, b.full_name) AS company_name, b.email AS business_email, g.full_name AS agent_name
       FROM site_audits a JOIN users b ON b.id = a.business_id LEFT JOIN business_profiles bp ON bp.user_id = b.id LEFT JOIN users g ON g.id = a.agent_id
       ${ref ? 'WHERE a.public_ref = ?' : status ? 'WHERE a.status = ?' : ''} ORDER BY a.id DESC LIMIT 300`, ref ? [ref] : status ? [status] : []
    );
    return rows.map((r) => ({ ...toAudit(r), businessName: r.business_name, companyName: r.company_name, businessEmail: r.business_email, agentName: r.agent_name }));
  },
  async events(auditId) {
    const rows = await query('SELECT type, actor, note, created_at FROM audit_events WHERE audit_id = ? ORDER BY id', [auditId]);
    return rows.map((e) => ({ type: e.type, actor: e.actor, note: e.note, at: e.created_at }));
  },
  async addEvent(auditId, type, actor, note) {
    await query('INSERT INTO audit_events (audit_id, type, actor, note) VALUES (?, ?, ?, ?)', [auditId, type, actor, note ?? null]);
  },

  // The admin picks (or changes) the agent. Only a waiting, assigned or reopened audit can be handed over.
  async assign(auditId, agentId) {
    return withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT status FROM site_audits WHERE id = ? FOR UPDATE', [auditId]);
      const status = rows[0]?.status;
      if (!['requested', 'assigned', 'reopened'].includes(status)) return { ok: false, status: status ?? null };
      const next = status === 'reopened' ? 'reopened' : 'assigned';
      await conn.execute('UPDATE site_audits SET agent_id = ?, status = ?, assigned_at = UTC_TIMESTAMP() WHERE id = ?', [agentId, next, auditId]);
      await event(conn, auditId, status === 'reopened' ? 'reassigned' : 'assigned', 'admin');
      return { ok: true, status: next };
    });
  },
  // The agent starts the visit. A reopened audit stays reopened; the agent just carries on.
  async start(auditId, agentId) {
    return withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT status, agent_id FROM site_audits WHERE id = ? FOR UPDATE', [auditId]);
      const r = rows[0];
      if (!r || Number(r.agent_id) !== agentId) return { ok: false, status: r?.status ?? null };
      if (r.status === 'assigned') {
        await conn.execute("UPDATE site_audits SET status = 'in_progress', started_at = UTC_TIMESTAMP() WHERE id = ?", [auditId]);
        await event(conn, auditId, 'started', 'agent');
        return { ok: true, status: 'in_progress', changed: true };
      }
      return { ok: ['in_progress', 'reopened'].includes(r.status), status: r.status, changed: false };
    });
  },
  async saveDraft(auditId, agentId, form) {
    const res = await query(
      "UPDATE site_audits SET form_json = ? WHERE id = ? AND agent_id = ? AND status IN ('in_progress','reopened')",
      [JSON.stringify(form), auditId, agentId]
    );
    return res.affectedRows > 0;
  },

  async photos(auditId) {
    const rows = await query('SELECT slot, image_id FROM audit_photos WHERE audit_id = ?', [auditId]);
    return rows.map((r) => ({ slot: r.slot, imageId: Number(r.image_id) }));
  },
  async setPhoto(auditId, slot, imageId) {
    await query(
      'INSERT INTO audit_photos (audit_id, slot, image_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE image_id = VALUES(image_id), created_at = UTC_TIMESTAMP()',
      [auditId, slot, imageId]
    );
  },
  // Who may see this picture: the audit it belongs to, or nothing.
  async auditForImage(imageId) {
    const rows = await query(
      `SELECT a.id, a.business_id, a.agent_id FROM audit_photos p JOIN site_audits a ON a.id = p.audit_id WHERE p.image_id = ? LIMIT 1`, [imageId]
    );
    return rows[0] ? { id: Number(rows[0].id), businessId: Number(rows[0].business_id), agentId: rows[0].agent_id == null ? null : Number(rows[0].agent_id) } : null;
  },

  // Saves a finished version. The row is locked so two submits give two versions, never one overwriting the other.
  async submit(auditId, agentId, { form, result, assessmentId, kwhPerDay, eaasEligible }) {
    return withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT status, agent_id, version FROM site_audits WHERE id = ? FOR UPDATE', [auditId]);
      const r = rows[0];
      if (!r || Number(r.agent_id) !== agentId || !['in_progress', 'reopened'].includes(r.status)) return { ok: false, status: r?.status ?? null };
      const version = Number(r.version) + 1;
      await conn.execute('INSERT INTO audit_versions (audit_id, version, form_json, result_json, assessment_id) VALUES (?, ?, ?, ?, ?)',
        [auditId, version, JSON.stringify(form), JSON.stringify(result), assessmentId]);
      await conn.execute(
        `UPDATE site_audits SET status = 'completed', version = ?, form_json = ?, result_json = ?, assessment_id = ?, kwh_per_day = ?, eaas_eligible = ?,
         completed_at = UTC_TIMESTAMP(), review_note = NULL WHERE id = ?`,
        [version, JSON.stringify(form), JSON.stringify(result), assessmentId, kwhPerDay, eaasEligible ? 1 : 0, auditId]
      );
      await event(conn, auditId, version > 1 ? 'updated' : 'completed', 'agent');
      return { ok: true, version };
    });
  },
  // The admin flags a finished audit and sends it back to its agent. The old result stays on file.
  async reopen(auditId, note) {
    return withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT status FROM site_audits WHERE id = ? FOR UPDATE', [auditId]);
      if (rows[0]?.status !== 'completed') return { ok: false, status: rows[0]?.status ?? null };
      await conn.execute("UPDATE site_audits SET status = 'reopened', review_note = ? WHERE id = ?", [note, auditId]);
      await event(conn, auditId, 'reopened', 'admin', note);
      return { ok: true };
    });
  },
  async versions(auditId) {
    const rows = await query('SELECT version, assessment_id, created_at FROM audit_versions WHERE audit_id = ? ORDER BY version', [auditId]);
    return rows.map((v) => ({ version: Number(v.version), assessmentId: v.assessment_id == null ? null : Number(v.assessment_id), at: v.created_at }));
  },
  async countOpenForAgents() {
    const rows = await query("SELECT agent_id, COUNT(*) AS n FROM site_audits WHERE status IN ('assigned','in_progress','reopened') AND agent_id IS NOT NULL GROUP BY agent_id");
    return new Map(rows.map((r) => [Number(r.agent_id), Number(r.n)]));
  },

  // ---- field agents (accounts the admin creates) ----
  async listAgents() {
    const rows = await query("SELECT id, full_name, email, phone, status, email_verified_at, created_at FROM users WHERE role = 'field_agent' ORDER BY id DESC LIMIT 200");
    return rows.map((r) => ({ id: Number(r.id), fullName: r.full_name, email: r.email, phone: r.phone ?? null, status: r.status, active: r.status === 'active', createdAt: r.created_at }));
  },
  async findAgent(id) {
    const rows = await query("SELECT id, full_name, email, phone, status FROM users WHERE id = ? AND role = 'field_agent' LIMIT 1", [id]);
    return rows[0] ? { id: Number(rows[0].id), fullName: rows[0].full_name, email: rows[0].email, phone: rows[0].phone ?? null, active: rows[0].status === 'active' } : null;
  },
  async findUser(id) {
    const rows = await query('SELECT id, full_name, email, phone FROM users WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? { id: Number(rows[0].id), fullName: rows[0].full_name, email: rows[0].email, phone: rows[0].phone ?? null } : null;
  },
};
