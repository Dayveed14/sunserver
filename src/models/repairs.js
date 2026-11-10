import { query, withTransaction } from '../db/pool.js';

const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? []);
const toRequest = (r) => ({
  id: Number(r.id), ref: r.public_ref, customerId: Number(r.customer_id), status: r.status, faultType: r.fault_type, description: r.description,
  equipment: json(r.equipment), urgency: r.urgency, state: r.state, areaId: r.area_id, addressLine: r.address_line,
  contactName: r.contact_name, contactPhone: r.contact_phone, callOutFee: Number(r.call_out_fee), feeBand: r.fee_band, distanceKm: Number(r.distance_km),
  technicianId: r.technician_id == null ? null : Number(r.technician_id),
  paidAt: r.paid_at, assignedAt: r.assigned_at, onTheWayAt: r.on_the_way_at, arrivedAt: r.arrived_at, inspectedAt: r.inspected_at,
  cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason, refundAmount: Number(r.refund_amount), refundNeeded: Boolean(r.refund_needed), createdAt: r.created_at,
});
const toPayment = (r) => ({ id: Number(r.id), requestId: Number(r.request_id), purpose: r.purpose, reference: r.reference, amount: Number(r.amount), status: r.status, authorizationUrl: r.authorization_url, paidAt: r.paid_at });
const toMatch = (r) => ({
  id: Number(r.id), requestId: Number(r.request_id), technicianId: Number(r.technician_id), rank: Number(r.rank_no), score: Number(r.score), distanceKm: Number(r.distance_km),
  status: r.status, adminDueAt: r.admin_due_at, techDueAt: r.tech_due_at, decidedBy: r.decided_by, respondedAt: r.responded_at,
  ...(r.full_name !== undefined ? { technicianName: r.full_name } : {}),
});
const toReport = (r) => (r ? { findings: r.findings, parts: json(r.parts), labour: Number(r.labour), estimatedHours: Number(r.estimated_hours), total: Number(r.total), createdAt: r.created_at, technicianId: Number(r.technician_id) } : null);
const addEv = (conn, requestId, type, actor, note = null) =>
  conn.execute('INSERT INTO repair_events (request_id, type, actor, note) VALUES (?, ?, ?, ?)', [requestId, type, actor, note]);

// States in which a technician is "busy" with a repair.
const ACTIVE = "('assigned','on_the_way','on_site','inspected','approved','in_repair','awaiting_parts','repair_done')";

export const repairsModel = {
  async create(d) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(
        `INSERT INTO repair_requests (public_ref, customer_id, fault_type, description, equipment, urgency, state, area_id, address_line, contact_name, contact_phone, call_out_fee, fee_band, distance_km)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.ref, d.customerId, d.faultType, d.description, JSON.stringify(d.equipment), d.urgency, d.state, d.areaId, d.addressLine, d.contactName, d.contactPhone, d.callOutFee, d.feeBand, d.distanceKm]
      );
      await addEv(conn, res.insertId, 'requested', 'customer');
      return res.insertId;
    });
  },
  async findByRef(ref) {
    const rows = await query('SELECT * FROM repair_requests WHERE public_ref = ? LIMIT 1', [ref]);
    return rows[0] ? toRequest(rows[0]) : null;
  },
  async findById(id) {
    const rows = await query('SELECT * FROM repair_requests WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? toRequest(rows[0]) : null;
  },
  async listForCustomer(customerId) {
    return (await query('SELECT * FROM repair_requests WHERE customer_id = ? ORDER BY id DESC LIMIT 100', [customerId])).map(toRequest);
  },
  async listForAdmin({ status, needsAction } = {}) {
    const where = needsAction ? "r.status = 'finding'" : status ? 'r.status = ?' : "r.status NOT IN ('quote')";
    const rows = await query(
      `SELECT r.*, c.full_name AS customer_name, t.full_name AS technician_name,
              (SELECT m.status FROM repair_matches m WHERE m.request_id = r.id AND m.status IN ('recommended','offered') ORDER BY m.id DESC LIMIT 1) AS match_state
       FROM repair_requests r JOIN users c ON c.id = r.customer_id LEFT JOIN users t ON t.id = r.technician_id
       WHERE ${where} ORDER BY r.id DESC LIMIT 200`,
      !needsAction && status ? [status] : []
    );
    return rows.map((r) => ({ ...toRequest(r), customerName: r.customer_name, technicianName: r.technician_name, matchState: r.match_state }));
  },
  async adminStats() {
    const rows = await query("SELECT status, COUNT(*) AS n FROM repair_requests GROUP BY status");
    const refunds = await query('SELECT COUNT(*) AS n FROM repair_requests WHERE refund_needed = 1');
    return { byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])), refundsDue: Number(refunds[0].n) };
  },
  async events(requestId) {
    return (await query('SELECT type, actor, note, created_at FROM repair_events WHERE request_id = ? ORDER BY id', [requestId])).map((e) => ({ type: e.type, actor: e.actor, note: e.note, at: e.created_at }));
  },
  async addEvent(requestId, type, actor, note) {
    await query('INSERT INTO repair_events (request_id, type, actor, note) VALUES (?, ?, ?, ?)', [requestId, type, actor, note ?? null]);
  },

  // ---- payment (counted once, same safety rules as installations) ----
  async openPayment({ requestId, reference, amount }) {
    return withTransaction(async (conn) => {
      const [req] = await conn.execute('SELECT status FROM repair_requests WHERE id = ? FOR UPDATE', [requestId]);
      if (!req[0] || !['quote', 'awaiting_payment'].includes(req[0].status)) return { payment: null, created: false };
      const [open] = await conn.execute("SELECT * FROM repair_payments WHERE request_id = ? AND purpose = 'call_out' AND status = 'initiated' ORDER BY id DESC LIMIT 1", [requestId]);
      if (open[0]) return { payment: toPayment(open[0]), created: false };
      const [res] = await conn.execute("INSERT INTO repair_payments (request_id, purpose, reference, amount) VALUES (?, 'call_out', ?, ?)", [requestId, reference, amount]);
      await conn.execute("UPDATE repair_requests SET status = 'awaiting_payment' WHERE id = ? AND status = 'quote'", [requestId]);
      const [row] = await conn.execute('SELECT * FROM repair_payments WHERE id = ?', [res.insertId]);
      return { payment: toPayment(row[0]), created: true };
    });
  },
  async findPayment(reference) {
    const rows = await query('SELECT * FROM repair_payments WHERE reference = ? LIMIT 1', [reference]);
    return rows[0] ? toPayment(rows[0]) : null;
  },
  async latestPayment(requestId) {
    const rows = await query('SELECT * FROM repair_payments WHERE request_id = ? ORDER BY id DESC LIMIT 1', [requestId]);
    return rows[0] ? toPayment(rows[0]) : null;
  },
  async setPaymentAuth(id, { url, accessCode }) {
    await query('UPDATE repair_payments SET authorization_url = ?, access_code = ? WHERE id = ?', [url, accessCode, id]);
  },
  async failPayment(id) {
    await query("UPDATE repair_payments SET status = 'failed' WHERE id = ? AND status = 'initiated'", [id]);
  },
  // Counts the call-out fee once and moves the request to "finding a technician".
  async settlePayment({ paymentId, requestId, paidAt }) {
    return withTransaction(async (conn) => {
      const [claim] = await conn.execute("UPDATE repair_payments SET status = 'success', paid_at = ? WHERE id = ? AND status <> 'success'", [paidAt, paymentId]);
      if (claim.affectedRows === 0) return { replay: true, opened: false };
      const [won] = await conn.execute("UPDATE repair_requests SET status = 'finding', paid_at = ? WHERE id = ? AND status IN ('quote','awaiting_payment')", [paidAt, requestId]);
      if (won.affectedRows > 0) await addEv(conn, requestId, 'paid', 'customer');
      return { replay: false, opened: won.affectedRows > 0 };
    });
  },

  // ---- photos ----
  async addPhoto({ requestId, uploaderId, kind, mime, size, data, remote }) {
    const res = await query(
      'INSERT INTO repair_photos (request_id, uploader_id, kind, mime, bytes, data, remote_url, public_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [requestId, uploaderId, kind, mime, size, remote ? null : data, remote?.url ?? null, remote?.publicId ?? null]
    );
    return res.insertId;
  },
  async photos(requestId, kind = null) {
    const rows = await query(`SELECT id, kind, mime, bytes, uploader_id, created_at FROM repair_photos WHERE request_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY id`, kind ? [requestId, kind] : [requestId]);
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind, mime: r.mime, bytes: Number(r.bytes), uploaderId: Number(r.uploader_id), createdAt: r.created_at }));
  },
  async photoFile(requestId, id) {
    const rows = await query('SELECT id, kind, mime, data, remote_url, public_id FROM repair_photos WHERE id = ? AND request_id = ? LIMIT 1', [id, requestId]);
    const r = rows[0];
    return r ? { id: Number(r.id), kind: r.kind, mime: r.mime, data: r.data, remoteUrl: r.remote_url, publicId: r.public_id } : null;
  },
  async removePhoto(requestId, id, uploaderId) {
    const rows = await query('SELECT public_id FROM repair_photos WHERE id = ? AND request_id = ? AND uploader_id = ?', [id, requestId, uploaderId]);
    if (!rows[0]) return null;
    await query('DELETE FROM repair_photos WHERE id = ?', [id]);
    return { publicId: rows[0].public_id };
  },

  // ---- technicians ----
  // Verified, active technicians who take repairs, with what ranking needs to know.
  async candidates() {
    const rows = await query(
      `SELECT u.id, u.email, u.full_name, a.state, a.area_id, i.travel_km, i.capacity, i.response_time, i.years_experience,
              (SELECT COUNT(*) FROM install_requests x WHERE x.installer_id = u.id AND x.status IN ('assigned','installer_done')) +
              (SELECT COUNT(*) FROM repair_requests y WHERE y.technician_id = u.id AND y.status IN ${ACTIVE}) AS active_jobs,
              (SELECT COUNT(*) FROM install_requests x WHERE x.installer_id = u.id AND x.status = 'completed') +
              (SELECT COUNT(*) FROM repair_requests y WHERE y.technician_id = u.id AND y.status = 'completed') AS completed_jobs
       FROM users u
       JOIN installer_profiles i ON i.user_id = u.id AND i.verification_status = 'verified' AND i.accepts_repairs = 1
       JOIN addresses a ON a.user_id = u.id
       WHERE u.role = 'installer' AND u.status = 'active' AND u.email_verified_at IS NOT NULL`
    );
    return rows.map((r) => ({
      id: Number(r.id), email: r.email, fullName: r.full_name, state: r.state, areaId: r.area_id, travelKm: r.travel_km == null ? null : Number(r.travel_km),
      capacity: r.capacity == null ? null : Number(r.capacity), responseTime: r.response_time, yearsExperience: r.years_experience == null ? null : Number(r.years_experience),
      activeJobs: Number(r.active_jobs), completedJobs: Number(r.completed_jobs), rating: null,
    }));
  },

  // ---- matching ----
  async startMatching(requestId, ranked, adminDueAt) {
    return withTransaction(async (conn) => {
      let n = 0;
      for (const c of ranked) {
        if (c.atCapacity) continue;
        n += 1;
        await conn.execute(
          'INSERT IGNORE INTO repair_matches (request_id, technician_id, rank_no, score, distance_km, status, admin_due_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [requestId, c.id, n, c.score, c.distanceKm, n === 1 ? 'recommended' : 'queued', n === 1 ? adminDueAt : null]
        );
      }
      return n;
    });
  },
  async matches(requestId) {
    const rows = await query('SELECT m.*, u.full_name FROM repair_matches m JOIN users u ON u.id = m.technician_id WHERE m.request_id = ? ORDER BY m.rank_no, m.id', [requestId]);
    return rows.map(toMatch);
  },
  async currentMatch(requestId, statuses) {
    const rows = await query(`SELECT * FROM repair_matches WHERE request_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, [requestId, ...statuses]);
    return rows[0] ? toMatch(rows[0]) : null;
  },
  // Moves a match from one status to another only if it is still in the expected one (so two actors cannot both win).
  async moveMatch(id, from, to, { techDueAt = null, adminDueAt = null, decidedBy = null } = {}) {
    const res = await query(
      'UPDATE repair_matches SET status = ?, tech_due_at = COALESCE(?, tech_due_at), admin_due_at = COALESCE(?, admin_due_at), decided_by = COALESCE(?, decided_by), responded_at = UTC_TIMESTAMP() WHERE id = ? AND status = ?',
      [to, techDueAt, adminDueAt, decidedBy, id, from]
    );
    return res.affectedRows > 0;
  },
  // The next queued match becomes the recommendation. Null when the list is used up.
  async promoteNext(requestId, adminDueAt) {
    return withTransaction(async (conn) => {
      const [busy] = await conn.execute("SELECT id FROM repair_matches WHERE request_id = ? AND status IN ('recommended','offered') LIMIT 1 FOR UPDATE", [requestId]);
      if (busy[0]) return null;
      const [next] = await conn.execute("SELECT * FROM repair_matches WHERE request_id = ? AND status = 'queued' ORDER BY rank_no LIMIT 1 FOR UPDATE", [requestId]);
      if (!next[0]) return null;
      await conn.execute("UPDATE repair_matches SET status = 'recommended', admin_due_at = ? WHERE id = ?", [adminDueAt, next[0].id]);
      return toMatch({ ...next[0], status: 'recommended', admin_due_at: adminDueAt });
    });
  },
  // The admin picks a technician by hand: any other open recommendation or offer is set aside and this one is offered.
  async offerTo({ requestId, technician, rankNo, score, distanceKm, techDueAt, adminId }) {
    return withTransaction(async (conn) => {
      const [req] = await conn.execute("SELECT status FROM repair_requests WHERE id = ? FOR UPDATE", [requestId]);
      if (!req[0] || req[0].status !== 'finding') return false;
      await conn.execute("UPDATE repair_matches SET status = 'passed', responded_at = UTC_TIMESTAMP() WHERE request_id = ? AND status IN ('recommended','offered') AND technician_id <> ?", [requestId, technician]);
      await conn.execute(
        `INSERT INTO repair_matches (request_id, technician_id, rank_no, score, distance_km, status, tech_due_at, decided_by) VALUES (?, ?, ?, ?, ?, 'offered', ?, ?)
         ON DUPLICATE KEY UPDATE status = 'offered', tech_due_at = VALUES(tech_due_at), decided_by = VALUES(decided_by), responded_at = UTC_TIMESTAMP()`,
        [requestId, technician, rankNo, score, distanceKm, techDueAt, `admin:${adminId}`]
      );
      return true;
    });
  },
  async dueAdmin(before) {
    return (await query("SELECT m.* FROM repair_matches m JOIN repair_requests r ON r.id = m.request_id WHERE m.status = 'recommended' AND m.admin_due_at <= ? AND r.status = 'finding'", [before])).map(toMatch);
  },
  async dueTechnician(before) {
    return (await query("SELECT m.* FROM repair_matches m JOIN repair_requests r ON r.id = m.request_id WHERE m.status = 'offered' AND m.tech_due_at <= ? AND r.status = 'finding'", [before])).map(toMatch);
  },
  // Offers waiting for this technician.
  async offersFor(technicianId) {
    const rows = await query(
      `SELECT r.*, m.tech_due_at FROM repair_matches m JOIN repair_requests r ON r.id = m.request_id
       WHERE m.technician_id = ? AND m.status = 'offered' AND r.status = 'finding' ORDER BY r.id DESC LIMIT 50`,
      [technicianId]
    );
    return rows.map((r) => ({ ...toRequest(r), techDueAt: r.tech_due_at }));
  },
  async offerFor(requestId, technicianId) {
    const rows = await query("SELECT * FROM repair_matches WHERE request_id = ? AND technician_id = ? AND status = 'offered' LIMIT 1", [requestId, technicianId]);
    return rows[0] ? toMatch(rows[0]) : null;
  },
  // The technician says yes: only the one offered technician can win, only while the job is still being matched.
  async accept({ requestId, technicianId, at }) {
    return withTransaction(async (conn) => {
      const [m] = await conn.execute("UPDATE repair_matches SET status = 'accepted', responded_at = ? WHERE request_id = ? AND technician_id = ? AND status = 'offered'", [at, requestId, technicianId]);
      if (m.affectedRows === 0) return false;
      const [r] = await conn.execute("UPDATE repair_requests SET status = 'assigned', technician_id = ?, assigned_at = ? WHERE id = ? AND status = 'finding'", [technicianId, at, requestId]);
      if (r.affectedRows === 0) return false;
      await addEv(conn, requestId, 'accepted', 'technician');
      return true;
    });
  },
  async jobsFor(technicianId) {
    return (await query('SELECT * FROM repair_requests WHERE technician_id = ? ORDER BY id DESC LIMIT 100', [technicianId])).map(toRequest);
  },

  // ---- visit steps ----
  async step({ requestId, technicianId, from, to, column, at, event }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(`UPDATE repair_requests SET status = ?, ${column} = ? WHERE id = ? AND technician_id = ? AND status = ?`, [to, at, requestId, technicianId, from]);
      if (res.affectedRows === 0) return false;
      await addEv(conn, requestId, event, 'technician');
      return true;
    });
  },
  async saveReport({ requestId, technicianId, findings, parts, labour, estimatedHours, total, at }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute("UPDATE repair_requests SET status = 'inspected', inspected_at = ? WHERE id = ? AND technician_id = ? AND status = 'on_site'", [at, requestId, technicianId]);
      if (res.affectedRows === 0) return false;
      await conn.execute(
        'INSERT INTO repair_reports (request_id, technician_id, findings, parts, labour, estimated_hours, total) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [requestId, technicianId, findings, JSON.stringify(parts), labour, estimatedHours, total]
      );
      await addEv(conn, requestId, 'inspected', 'technician');
      return true;
    });
  },
  async report(requestId) {
    const rows = await query('SELECT * FROM repair_reports WHERE request_id = ? LIMIT 1', [requestId]);
    return toReport(rows[0]);
  },

  // ---- cancelling ----
  // Marks the request cancelled and notes the refund the admin must pay by hand. Only from the listed statuses.
  async cancel({ requestId, reason, at, refundAmount, from, actor }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(
        `UPDATE repair_requests SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, refund_amount = ?, refund_needed = ? WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
        [at, reason, refundAmount, refundAmount > 0 ? 1 : 0, requestId, ...from]
      );
      if (res.affectedRows === 0) return false;
      await conn.execute("UPDATE repair_matches SET status = 'passed', responded_at = ? WHERE request_id = ? AND status IN ('queued','recommended','offered')", [at, requestId]);
      await addEv(conn, requestId, 'cancelled', actor, reason);
      return true;
    });
  },
  async markRefunded(requestId) {
    const res = await query('UPDATE repair_requests SET refund_needed = 0 WHERE id = ? AND refund_needed = 1', [requestId]);
    return res.affectedRows > 0;
  },
};
