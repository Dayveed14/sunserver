import { query, withTransaction } from '../db/pool.js';

const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? []);
const toRequest = (r) => ({
  id: Number(r.id), ref: r.public_ref, customerId: Number(r.customer_id), status: r.status, faultType: r.fault_type, description: r.description,
  equipment: json(r.equipment), urgency: r.urgency, state: r.state, areaId: r.area_id, addressLine: r.address_line,
  contactName: r.contact_name, contactPhone: r.contact_phone, callOutFee: Number(r.call_out_fee), feeBand: r.fee_band, distanceKm: Number(r.distance_km),
  technicianId: r.technician_id == null ? null : Number(r.technician_id),
  paidAt: r.paid_at, assignedAt: r.assigned_at, onTheWayAt: r.on_the_way_at, arrivedAt: r.arrived_at, inspectedAt: r.inspected_at,
  cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason, refundAmount: Number(r.refund_amount), refundNeeded: Boolean(r.refund_needed), createdAt: r.created_at,
  agreedTotal: r.agreed_total == null ? null : Number(r.agreed_total), paidAmount: Number(r.paid_amount ?? 0), approvedAt: r.approved_at, repairStartedAt: r.repair_started_at,
  repairDoneAt: r.repair_done_at, completedAt: r.completed_at, confirmDueAt: r.confirm_due_at, problemAt: r.problem_at, problemNote: r.problem_note, partsNote: r.parts_note,
  payoutAmount: Number(r.payout_amount ?? 0), payoutStatus: r.payout_status ?? 'none', payoutPaidAt: r.payout_paid_at,
});
const toVariation = (r) => (r ? { id: Number(r.id), requestId: Number(r.request_id), technicianId: Number(r.technician_id), reason: r.reason, parts: json(r.parts), labour: Number(r.labour), extraTotal: Number(r.extra_total), status: r.status, createdAt: r.created_at, decidedAt: r.decided_at } : null);
const toPayment = (r) => ({ id: Number(r.id), requestId: Number(r.request_id), variationId: r.variation_id == null ? null : Number(r.variation_id), purpose: r.purpose, reference: r.reference, amount: Number(r.amount), status: r.status, authorizationUrl: r.authorization_url, paidAt: r.paid_at });
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
    const where = needsAction ? "(r.status = 'finding' OR (r.status = 'repair_done' AND r.problem_at IS NOT NULL) OR r.refund_needed = 1 OR r.payout_status = 'owed')" : status ? 'r.status = ?' : "r.status NOT IN ('quote')";
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
    const extra = await query("SELECT SUM(refund_needed = 1) AS refunds, SUM(payout_status = 'owed') AS payouts, SUM(status = 'repair_done' AND problem_at IS NOT NULL) AS problems, COALESCE(SUM(CASE WHEN payout_status = 'owed' THEN payout_amount END), 0) AS owed FROM repair_requests");
    return { byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])), refundsDue: Number(extra[0].refunds ?? 0), payoutsOwed: Number(extra[0].payouts ?? 0), problems: Number(extra[0].problems ?? 0), payoutAmountOwed: Number(extra[0].owed ?? 0) };
  },
  async events(requestId) {
    return (await query('SELECT type, actor, note, created_at FROM repair_events WHERE request_id = ? ORDER BY id', [requestId])).map((e) => ({ type: e.type, actor: e.actor, note: e.note, at: e.created_at }));
  },
  async addEvent(requestId, type, actor, note) {
    await query('INSERT INTO repair_events (request_id, type, actor, note) VALUES (?, ?, ?, ?)', [requestId, type, actor, note ?? null]);
  },

  // ---- payment (counted once, same safety rules as installations) ----
  // One open payment per request and purpose (call_out, repair, variation). The request row is locked so two taps cannot start two.
  async openPayment({ requestId, reference, amount, purpose = 'call_out', variationId = null }) {
    const allowed = { call_out: ['quote', 'awaiting_payment'], repair: ['inspected'], variation: ['in_repair', 'awaiting_parts'] }[purpose];
    return withTransaction(async (conn) => {
      const [req] = await conn.execute('SELECT status FROM repair_requests WHERE id = ? FOR UPDATE', [requestId]);
      if (!req[0] || !allowed.includes(req[0].status)) return { payment: null, created: false };
      if (purpose === 'variation') {
        const [v] = await conn.execute("SELECT id FROM repair_variations WHERE id = ? AND request_id = ? AND status = 'proposed' FOR UPDATE", [variationId, requestId]);
        if (!v[0]) return { payment: null, created: false };
      }
      const [open] = await conn.execute("SELECT * FROM repair_payments WHERE request_id = ? AND purpose = ? AND status = 'initiated' AND (variation_id <=> ?) ORDER BY id DESC LIMIT 1", [requestId, purpose, variationId]);
      if (open[0]) return { payment: toPayment(open[0]), created: false };
      const [res] = await conn.execute('INSERT INTO repair_payments (request_id, purpose, reference, amount, variation_id) VALUES (?, ?, ?, ?, ?)', [requestId, purpose, reference, amount, variationId]);
      if (purpose === 'call_out') await conn.execute("UPDATE repair_requests SET status = 'awaiting_payment' WHERE id = ? AND status = 'quote'", [requestId]);
      const [row] = await conn.execute('SELECT * FROM repair_payments WHERE id = ?', [res.insertId]);
      return { payment: toPayment(row[0]), created: true };
    });
  },
  async findPayment(reference) {
    const rows = await query('SELECT * FROM repair_payments WHERE reference = ? LIMIT 1', [reference]);
    return rows[0] ? toPayment(rows[0]) : null;
  },
  async latestPayment(requestId, purpose = null) {
    const rows = await query(`SELECT * FROM repair_payments WHERE request_id = ? ${purpose ? 'AND purpose = ?' : ''} ORDER BY id DESC LIMIT 1`, purpose ? [requestId, purpose] : [requestId]);
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
      const [won] = await conn.execute("UPDATE repair_requests SET status = 'finding', paid_at = ?, paid_amount = paid_amount + (SELECT amount FROM repair_payments WHERE id = ?) WHERE id = ? AND status IN ('quote','awaiting_payment')", [paidAt, paymentId, requestId]);
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
              (SELECT COUNT(*) FROM repair_requests y WHERE y.technician_id = u.id AND y.status = 'completed') AS completed_jobs,
              (SELECT AVG(v.rating) FROM repair_reviews v WHERE v.technician_id = u.id) AS rating
       FROM users u
       JOIN installer_profiles i ON i.user_id = u.id AND i.verification_status = 'verified' AND i.accepts_repairs = 1
       JOIN addresses a ON a.user_id = u.id
       WHERE u.role = 'installer' AND u.status = 'active' AND u.email_verified_at IS NOT NULL`
    );
    return rows.map((r) => ({
      id: Number(r.id), email: r.email, fullName: r.full_name, state: r.state, areaId: r.area_id, travelKm: r.travel_km == null ? null : Number(r.travel_km),
      capacity: r.capacity == null ? null : Number(r.capacity), responseTime: r.response_time, yearsExperience: r.years_experience == null ? null : Number(r.years_experience),
      activeJobs: Number(r.active_jobs), completedJobs: Number(r.completed_jobs), rating: r.rating == null ? null : Number(r.rating),
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
  async cancel({ requestId, reason, at, refundAmount, from, actor, payoutAmount = 0 }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(
        `UPDATE repair_requests SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, refund_amount = ?, refund_needed = ?, payout_amount = ?, payout_status = ? WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
        [at, reason, refundAmount, refundAmount > 0 ? 1 : 0, payoutAmount, payoutAmount > 0 ? 'owed' : 'none', requestId, ...from]
      );
      if (res.affectedRows === 0) return false;
      await conn.execute("UPDATE repair_matches SET status = 'passed', responded_at = ? WHERE request_id = ? AND status IN ('queued','recommended','offered')", [at, requestId]);
      await conn.execute("UPDATE repair_variations SET status = 'withdrawn', decided_at = ? WHERE request_id = ? AND status = 'proposed'", [at, requestId]);
      await addEv(conn, requestId, 'cancelled', actor, reason);
      return true;
    });
  },
  async markRefunded(requestId) {
    const res = await query('UPDATE repair_requests SET refund_needed = 0 WHERE id = ? AND refund_needed = 1', [requestId]);
    return res.affectedRows > 0;
  },
  // ---- part B: quote approval, the repair, completion, payout, reviews ----
  async settleRepairPayment({ paymentId, requestId, total, paidAt }) {
    return withTransaction(async (conn) => {
      const [claim] = await conn.execute("UPDATE repair_payments SET status = 'success', paid_at = ? WHERE id = ? AND status <> 'success'", [paidAt, paymentId]);
      if (claim.affectedRows === 0) return { replay: true, ok: false };
      const [won] = await conn.execute("UPDATE repair_requests SET status = 'approved', approved_at = ?, agreed_total = ?, paid_amount = paid_amount + (SELECT amount FROM repair_payments WHERE id = ?) WHERE id = ? AND status = 'inspected'", [paidAt, total, paymentId, requestId]);
      if (won.affectedRows > 0) await addEv(conn, requestId, 'quote_approved', 'customer');
      return { replay: false, ok: won.affectedRows > 0 };
    });
  },
  // The call-out fee already covers the whole quote: nothing more to pay.
  async approveFree({ requestId, total, at }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute("UPDATE repair_requests SET status = 'approved', approved_at = ?, agreed_total = ? WHERE id = ? AND status = 'inspected'", [at, total, requestId]);
      if (res.affectedRows === 0) return false;
      await addEv(conn, requestId, 'quote_approved', 'customer');
      return true;
    });
  },
  // The customer turns the quote down: the visit is kept, the technician is owed their share of the call-out fee.
  async declineQuote({ requestId, at, payoutAmount }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute("UPDATE repair_requests SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'The customer did not go ahead with the repair after the inspection', refund_amount = 0, refund_needed = 0, payout_amount = ?, payout_status = ? WHERE id = ? AND status = 'inspected'", [at, payoutAmount, payoutAmount > 0 ? 'owed' : 'none', requestId]);
      if (res.affectedRows === 0) return false;
      await addEv(conn, requestId, 'quote_declined', 'customer');
      return true;
    });
  },
  async startRepair({ requestId, technicianId, at }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute("UPDATE repair_requests SET status = 'in_repair', repair_started_at = ? WHERE id = ? AND technician_id = ? AND status = 'approved'", [at, requestId, technicianId]);
      if (res.affectedRows === 0) return false;
      await addEv(conn, requestId, 'repair_started', 'technician');
      return true;
    });
  },
  async setAwaitingParts({ requestId, technicianId, waiting, note }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(
        waiting ? "UPDATE repair_requests SET status = 'awaiting_parts', parts_note = ? WHERE id = ? AND technician_id = ? AND status = 'in_repair'" : "UPDATE repair_requests SET status = 'in_repair', parts_note = NULL WHERE id = ? AND technician_id = ? AND status = 'awaiting_parts'",
        waiting ? [note, requestId, technicianId] : [requestId, technicianId]
      );
      if (res.affectedRows === 0) return false;
      await addEv(conn, requestId, waiting ? 'awaiting_parts' : 'parts_arrived', 'technician', waiting ? note : null);
      return true;
    });
  },

  async variations(requestId) {
    return (await query('SELECT * FROM repair_variations WHERE request_id = ? ORDER BY id', [requestId])).map(toVariation);
  },
  async findVariation(id, requestId) {
    const rows = await query('SELECT * FROM repair_variations WHERE id = ? AND request_id = ? LIMIT 1', [id, requestId]);
    return toVariation(rows[0]);
  },
  // One pending variation at a time, only while the repair is under way.
  async proposeVariation({ requestId, technicianId, reason, parts, labour, extraTotal }) {
    return withTransaction(async (conn) => {
      const [req] = await conn.execute("SELECT status FROM repair_requests WHERE id = ? AND technician_id = ? FOR UPDATE", [requestId, technicianId]);
      if (!req[0] || !['in_repair', 'awaiting_parts'].includes(req[0].status)) return { error: 'NOT_READY' };
      const [open] = await conn.execute("SELECT id FROM repair_variations WHERE request_id = ? AND status = 'proposed' LIMIT 1", [requestId]);
      if (open[0]) return { error: 'PENDING' };
      const [res] = await conn.execute('INSERT INTO repair_variations (request_id, technician_id, reason, parts, labour, extra_total) VALUES (?, ?, ?, ?, ?, ?)', [requestId, technicianId, reason, JSON.stringify(parts), labour, extraTotal]);
      await addEv(conn, requestId, 'variation_proposed', 'technician');
      return { id: res.insertId };
    });
  },
  async closeVariation({ id, requestId, to, at, actor }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute("UPDATE repair_variations SET status = ?, decided_at = ? WHERE id = ? AND request_id = ? AND status = 'proposed'", [to, at, id, requestId]);
      if (res.affectedRows === 0) return false;
      await addEv(conn, requestId, to === 'declined' ? 'variation_declined' : 'variation_withdrawn', actor);
      return true;
    });
  },
  async settleVariationPayment({ paymentId, requestId, variationId, extra, paidAt }) {
    return withTransaction(async (conn) => {
      const [claim] = await conn.execute("UPDATE repair_payments SET status = 'success', paid_at = ? WHERE id = ? AND status <> 'success'", [paidAt, paymentId]);
      if (claim.affectedRows === 0) return { replay: true, ok: false };
      const [v] = await conn.execute("UPDATE repair_variations SET status = 'approved', decided_at = ? WHERE id = ? AND request_id = ? AND status = 'proposed'", [paidAt, variationId, requestId]);
      if (v.affectedRows === 0) return { replay: false, ok: false };
      const [r] = await conn.execute("UPDATE repair_requests SET agreed_total = agreed_total + ?, paid_amount = paid_amount + (SELECT amount FROM repair_payments WHERE id = ?) WHERE id = ? AND status IN ('in_repair','awaiting_parts')", [extra, paymentId, requestId]);
      if (r.affectedRows === 0) return { replay: false, ok: false };
      await addEv(conn, requestId, 'variation_approved', 'customer');
      return { replay: false, ok: true };
    });
  },

  async complete({ requestId, technicianId, summary, at, confirmDueAt }) {
    return withTransaction(async (conn) => {
      const [req] = await conn.execute("SELECT status FROM repair_requests WHERE id = ? AND technician_id = ? FOR UPDATE", [requestId, technicianId]);
      if (!req[0] || req[0].status !== 'in_repair') return { error: 'NOT_READY' };
      const [open] = await conn.execute("SELECT id FROM repair_variations WHERE request_id = ? AND status = 'proposed' LIMIT 1", [requestId]);
      if (open[0]) return { error: 'PENDING' };
      await conn.execute("UPDATE repair_requests SET status = 'repair_done', repair_done_at = ?, confirm_due_at = ? WHERE id = ?", [at, confirmDueAt, requestId]);
      await conn.execute('INSERT INTO repair_completions (request_id, technician_id, summary) VALUES (?, ?, ?)', [requestId, technicianId, summary]);
      await addEv(conn, requestId, 'repair_done', 'technician');
      return { ok: true };
    });
  },
  async completion(requestId) {
    const rows = await query('SELECT summary, created_at FROM repair_completions WHERE request_id = ? LIMIT 1', [requestId]);
    return rows[0] ? { summary: rows[0].summary, at: rows[0].created_at } : null;
  },
  // Closes the job and records what the technician is owed. Auto-close only when no problem has been raised.
  async confirm({ requestId, at, actor, payoutAmount }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(
        `UPDATE repair_requests SET status = 'completed', completed_at = ?, confirm_due_at = NULL, payout_amount = ?, payout_status = 'owed' WHERE id = ? AND status = 'repair_done'${actor === 'system' ? ' AND problem_at IS NULL' : ''}`,
        [at, payoutAmount, requestId]
      );
      if (res.affectedRows === 0) return false;
      await addEv(conn, requestId, actor === 'system' ? 'auto_confirmed' : actor === 'admin' ? 'admin_confirmed' : 'confirmed', actor);
      return true;
    });
  },
  async reportProblem({ requestId, note, at }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute("UPDATE repair_requests SET problem_at = ?, problem_note = ?, confirm_due_at = NULL WHERE id = ? AND status = 'repair_done' AND problem_at IS NULL", [at, note, requestId]);
      if (res.affectedRows === 0) return false;
      await addEv(conn, requestId, 'problem_reported', 'customer', note);
      return true;
    });
  },
  async dueConfirm(before) {
    return (await query("SELECT * FROM repair_requests WHERE status = 'repair_done' AND problem_at IS NULL AND confirm_due_at <= ?", [before])).map(toRequest);
  },
  async markPayoutPaid(requestId, at) {
    const res = await query("UPDATE repair_requests SET payout_status = 'paid', payout_paid_at = ? WHERE id = ? AND payout_status = 'owed'", [at, requestId]);
    return res.affectedRows > 0;
  },
  async earnings(technicianId) {
    const rows = await query("SELECT COALESCE(SUM(CASE WHEN payout_status = 'owed' THEN payout_amount END), 0) AS owed, COALESCE(SUM(CASE WHEN payout_status = 'paid' THEN payout_amount END), 0) AS paid FROM repair_requests WHERE technician_id = ?", [technicianId]);
    return { owed: Number(rows[0].owed), paid: Number(rows[0].paid) };
  },
  async addReview({ requestId, customerId, technicianId, rating, comment }) {
    try {
      await query('INSERT INTO repair_reviews (request_id, customer_id, technician_id, rating, comment) VALUES (?, ?, ?, ?, ?)', [requestId, customerId, technicianId, rating, comment ?? null]);
      return true;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  },
  async review(requestId) {
    const rows = await query('SELECT rating, comment, created_at FROM repair_reviews WHERE request_id = ? LIMIT 1', [requestId]);
    return rows[0] ? { rating: Number(rows[0].rating), comment: rows[0].comment, at: rows[0].created_at } : null;
  },
  async ratingFor(technicianId) {
    const rows = await query('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM repair_reviews WHERE technician_id = ?', [technicianId]);
    return { average: rows[0].avg == null ? null : Math.round(Number(rows[0].avg) * 10) / 10, count: Number(rows[0].n) };
  },
};
