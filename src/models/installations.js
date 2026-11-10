import { query, withTransaction } from '../db/pool.js';

const toRequest = (r) => ({
  id: Number(r.id), ref: r.public_ref, customerId: Number(r.customer_id), status: r.status, description: r.description,
  systemKw: Number(r.system_kw), bandId: r.band_id, bandLabel: r.band_label, price: Number(r.price), installerPayout: Number(r.installer_payout),
  state: r.state, areaId: r.area_id, addressLine: r.address_line, contactName: r.contact_name, contactPhone: r.contact_phone,
  preferredDate: typeof r.preferred_date === 'string' ? r.preferred_date : r.preferred_date.toISOString().slice(0, 10),
  installerId: r.installer_id == null ? null : Number(r.installer_id),
  openAt: r.open_at, assignedAt: r.assigned_at, installerDoneAt: r.installer_done_at, completedAt: r.completed_at, alertedAt: r.alerted_at,
  cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason, refundNeeded: Boolean(r.refund_needed),
  payoutStatus: r.payout_status, payoutPaidAt: r.payout_paid_at, createdAt: r.created_at,
  payoutAmount: Number(r.payout_amount ?? r.installer_payout), refundAmount: Number(r.refund_amount ?? 0),
  onTheWayAt: r.on_the_way_at, arrivedAt: r.arrived_at, startedAt: r.started_at, problemAt: r.problem_at, problemNote: r.problem_note,
});
const toMatch = (r) => ({
  id: Number(r.id), requestId: Number(r.request_id), installerId: Number(r.installer_id), rank: Number(r.rank_no), score: Number(r.score), distanceKm: Number(r.distance_km),
  status: r.status, adminDueAt: r.admin_due_at, techDueAt: r.tech_due_at, decidedBy: r.decided_by, respondedAt: r.responded_at,
  ...(r.full_name !== undefined ? { installerName: r.full_name } : {}),
});
// Statuses in which an installer is busy with an installation.
const ACTIVE = "('assigned','on_the_way','on_site','in_progress','installer_done')";
const toPayment = (r) => ({ id: Number(r.id), requestId: Number(r.request_id), reference: r.reference, amount: Number(r.amount), status: r.status, authorizationUrl: r.authorization_url, paidAt: r.paid_at });

const event = (conn, requestId, type, actor, note = null) =>
  conn.execute('INSERT INTO install_events (request_id, type, actor, note) VALUES (?, ?, ?, ?)', [requestId, type, actor, note]);

export const installationsModel = {
  async create(d) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(
        `INSERT INTO install_requests (public_ref, customer_id, description, system_kw, band_id, band_label, price, installer_payout, payout_amount, state, area_id, address_line, contact_name, contact_phone, preferred_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.ref, d.customerId, d.description, d.systemKw, d.bandId, d.bandLabel, d.price, d.installerPayout, d.installerPayout, d.state, d.areaId, d.addressLine, d.contactName, d.contactPhone, d.preferredDate]
      );
      await event(conn, res.insertId, 'quoted', 'customer');
      return res.insertId;
    });
  },
  async findByRef(ref) {
    const rows = await query('SELECT * FROM install_requests WHERE public_ref = ? LIMIT 1', [ref]);
    return rows[0] ? toRequest(rows[0]) : null;
  },
  async findById(id) {
    const rows = await query('SELECT * FROM install_requests WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? toRequest(rows[0]) : null;
  },
  async listForCustomer(customerId) {
    const rows = await query('SELECT * FROM install_requests WHERE customer_id = ? ORDER BY id DESC LIMIT 100', [customerId]);
    return rows.map(toRequest);
  },
  async listForAdmin({ status, needsAction } = {}) {
    const where = needsAction ? "(r.status = 'finding' OR (r.status = 'installer_done' AND r.problem_at IS NOT NULL) OR r.refund_needed = 1 OR r.payout_status = 'owed')" : status ? 'r.status = ?' : "r.status NOT IN ('quote')";
    const rows = await query(
      `SELECT r.*, c.full_name AS customer_name, c.email AS customer_email, i.full_name AS installer_name,
              (SELECT m.status FROM install_matches m WHERE m.request_id = r.id AND m.status IN ('recommended','offered') ORDER BY m.id DESC LIMIT 1) AS match_state
       FROM install_requests r JOIN users c ON c.id = r.customer_id LEFT JOIN users i ON i.id = r.installer_id
       WHERE ${where} ORDER BY r.id DESC LIMIT 200`,
      !needsAction && status ? [status] : []
    );
    return rows.map((r) => ({ ...toRequest(r), customerName: r.customer_name, customerEmail: r.customer_email, installerName: r.installer_name, matchState: r.match_state }));
  },
  async events(requestId) {
    const rows = await query('SELECT type, actor, note, created_at FROM install_events WHERE request_id = ? ORDER BY id', [requestId]);
    return rows.map((e) => ({ type: e.type, actor: e.actor, note: e.note, at: e.created_at }));
  },
  async addEvent(requestId, type, actor, note) {
    await query('INSERT INTO install_events (request_id, type, actor, note) VALUES (?, ?, ?, ?)', [requestId, type, actor, note ?? null]);
  },

  // ---- payment (same safety rules as orders and registration fees) ----
  // Returns the open payment for this request or starts one. The request row is locked, so two taps give one payment.
  async openPayment({ requestId, reference, amount }) {
    return withTransaction(async (conn) => {
      const [req] = await conn.execute('SELECT status FROM install_requests WHERE id = ? FOR UPDATE', [requestId]);
      if (!req[0] || !['quote', 'awaiting_payment'].includes(req[0].status)) return { payment: null, created: false, status: req[0]?.status ?? null };
      const [open] = await conn.execute("SELECT * FROM install_payments WHERE request_id = ? AND status = 'initiated' ORDER BY id DESC LIMIT 1", [requestId]);
      if (open[0]) return { payment: toPayment(open[0]), created: false, status: req[0].status };
      const [res] = await conn.execute('INSERT INTO install_payments (request_id, reference, amount) VALUES (?, ?, ?)', [requestId, reference, amount]);
      await conn.execute("UPDATE install_requests SET status = 'awaiting_payment' WHERE id = ? AND status = 'quote'", [requestId]);
      const [row] = await conn.execute('SELECT * FROM install_payments WHERE id = ?', [res.insertId]);
      return { payment: toPayment(row[0]), created: true, status: 'awaiting_payment' };
    });
  },
  async findPayment(reference) {
    const rows = await query('SELECT * FROM install_payments WHERE reference = ? LIMIT 1', [reference]);
    return rows[0] ? toPayment(rows[0]) : null;
  },
  async latestPayment(requestId) {
    const rows = await query('SELECT * FROM install_payments WHERE request_id = ? ORDER BY id DESC LIMIT 1', [requestId]);
    return rows[0] ? toPayment(rows[0]) : null;
  },
  async setPaymentAuth(id, { url, accessCode }) {
    await query('UPDATE install_payments SET authorization_url = ?, access_code = ? WHERE id = ?', [url, accessCode, id]);
  },
  async failPayment(id) {
    await query("UPDATE install_payments SET status = 'failed' WHERE id = ? AND status = 'initiated'", [id]);
  },
  // Counts the payment once and opens the job. Returns { replay } when it was already counted.
  async settlePayment({ paymentId, requestId, paidAt }) {
    return withTransaction(async (conn) => {
      const [claim] = await conn.execute("UPDATE install_payments SET status = 'success', paid_at = ? WHERE id = ? AND status <> 'success'", [paidAt, paymentId]);
      if (claim.affectedRows === 0) return { replay: true, opened: false };
      const [won] = await conn.execute("UPDATE install_requests SET status = 'finding', open_at = ? WHERE id = ? AND status IN ('quote','awaiting_payment')", [paidAt, requestId]);
      if (won.affectedRows > 0) await event(conn, requestId, 'paid', 'customer');
      return { replay: false, opened: won.affectedRows > 0 };
    });
  },

  // ---- installers (ranking input) ----
  // Verified, active installers with what ranking needs to know. Ratings count repairs and installations together.
  async candidates() {
    const rows = await query(
      `SELECT u.id, u.email, u.full_name, a.state, a.area_id, i.travel_km, i.capacity, i.response_time, i.years_experience,
              (SELECT COUNT(*) FROM install_requests x WHERE x.installer_id = u.id AND x.status IN ${ACTIVE}) +
              (SELECT COUNT(*) FROM repair_requests y WHERE y.technician_id = u.id AND y.status IN ('assigned','on_the_way','on_site','inspected','approved','in_repair','awaiting_parts','repair_done')) AS active_jobs,
              (SELECT COUNT(*) FROM install_requests x WHERE x.installer_id = u.id AND x.status = 'completed') +
              (SELECT COUNT(*) FROM repair_requests y WHERE y.technician_id = u.id AND y.status = 'completed') AS completed_jobs,
              (SELECT AVG(v.rating) FROM (SELECT technician_id, rating FROM repair_reviews UNION ALL SELECT installer_id, rating FROM install_reviews) v WHERE v.technician_id = u.id) AS rating
       FROM users u
       JOIN installer_profiles i ON i.user_id = u.id AND i.verification_status = 'verified'
       JOIN addresses a ON a.user_id = u.id
       WHERE u.role = 'installer' AND u.status = 'active' AND u.email_verified_at IS NOT NULL`
    );
    return rows.map((r) => ({
      id: Number(r.id), email: r.email, fullName: r.full_name, state: r.state, areaId: r.area_id, travelKm: r.travel_km == null ? null : Number(r.travel_km),
      capacity: r.capacity == null ? null : Number(r.capacity), responseTime: r.response_time, yearsExperience: r.years_experience == null ? null : Number(r.years_experience),
      activeJobs: Number(r.active_jobs), completedJobs: Number(r.completed_jobs), rating: r.rating == null ? null : Number(r.rating),
    }));
  },

  // ---- matching (same rules as repairs) ----
  async startMatching(requestId, ranked, adminDueAt) {
    return withTransaction(async (conn) => {
      let n = 0;
      for (const c of ranked) {
        if (c.atCapacity) continue;
        n += 1;
        await conn.execute(
          'INSERT IGNORE INTO install_matches (request_id, installer_id, rank_no, score, distance_km, status, admin_due_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [requestId, c.id, n, c.score, c.distanceKm, n === 1 ? 'recommended' : 'queued', n === 1 ? adminDueAt : null]
        );
      }
      return n;
    });
  },
  async matches(requestId) {
    return (await query('SELECT m.*, u.full_name FROM install_matches m JOIN users u ON u.id = m.installer_id WHERE m.request_id = ? ORDER BY m.rank_no, m.id', [requestId])).map(toMatch);
  },
  async currentMatch(requestId, statuses) {
    const rows = await query(`SELECT * FROM install_matches WHERE request_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, [requestId, ...statuses]);
    return rows[0] ? toMatch(rows[0]) : null;
  },
  async moveMatch(id, from, to, { techDueAt = null, adminDueAt = null, decidedBy = null } = {}) {
    const res = await query(
      'UPDATE install_matches SET status = ?, tech_due_at = COALESCE(?, tech_due_at), admin_due_at = COALESCE(?, admin_due_at), decided_by = COALESCE(?, decided_by), responded_at = UTC_TIMESTAMP() WHERE id = ? AND status = ?',
      [to, techDueAt, adminDueAt, decidedBy, id, from]
    );
    return res.affectedRows > 0;
  },
  async promoteNext(requestId, adminDueAt) {
    return withTransaction(async (conn) => {
      const [busy] = await conn.execute("SELECT id FROM install_matches WHERE request_id = ? AND status IN ('recommended','offered') LIMIT 1 FOR UPDATE", [requestId]);
      if (busy[0]) return null;
      const [next] = await conn.execute("SELECT * FROM install_matches WHERE request_id = ? AND status = 'queued' ORDER BY rank_no LIMIT 1 FOR UPDATE", [requestId]);
      if (!next[0]) return null;
      await conn.execute("UPDATE install_matches SET status = 'recommended', admin_due_at = ? WHERE id = ?", [adminDueAt, next[0].id]);
      return toMatch({ ...next[0], status: 'recommended', admin_due_at: adminDueAt });
    });
  },
  async offerTo({ requestId, installer, rankNo, score, distanceKm, techDueAt, adminId }) {
    return withTransaction(async (conn) => {
      const [req] = await conn.execute('SELECT status FROM install_requests WHERE id = ? FOR UPDATE', [requestId]);
      if (!req[0] || req[0].status !== 'finding') return false;
      await conn.execute("UPDATE install_matches SET status = 'passed', responded_at = UTC_TIMESTAMP() WHERE request_id = ? AND status IN ('recommended','offered') AND installer_id <> ?", [requestId, installer]);
      await conn.execute(
        `INSERT INTO install_matches (request_id, installer_id, rank_no, score, distance_km, status, tech_due_at, decided_by) VALUES (?, ?, ?, ?, ?, 'offered', ?, ?)
         ON DUPLICATE KEY UPDATE status = 'offered', tech_due_at = VALUES(tech_due_at), decided_by = VALUES(decided_by), responded_at = UTC_TIMESTAMP()`,
        [requestId, installer, rankNo, score, distanceKm, techDueAt, `admin:${adminId}`]
      );
      return true;
    });
  },
  async dueAdmin(before) {
    return (await query("SELECT m.* FROM install_matches m JOIN install_requests r ON r.id = m.request_id WHERE m.status = 'recommended' AND m.admin_due_at <= ? AND r.status = 'finding'", [before])).map(toMatch);
  },
  async dueInstaller(before) {
    return (await query("SELECT m.* FROM install_matches m JOIN install_requests r ON r.id = m.request_id WHERE m.status = 'offered' AND m.tech_due_at <= ? AND r.status = 'finding'", [before])).map(toMatch);
  },
  async offersFor(installerId) {
    const rows = await query(
      `SELECT r.*, m.tech_due_at FROM install_matches m JOIN install_requests r ON r.id = m.request_id
       WHERE m.installer_id = ? AND m.status = 'offered' AND r.status = 'finding' ORDER BY r.id DESC LIMIT 50`,
      [installerId]
    );
    return rows.map((r) => ({ ...toRequest(r), techDueAt: r.tech_due_at }));
  },
  async offerFor(requestId, installerId) {
    const rows = await query("SELECT * FROM install_matches WHERE request_id = ? AND installer_id = ? AND status = 'offered' LIMIT 1", [requestId, installerId]);
    return rows[0] ? toMatch(rows[0]) : null;
  },
  // The installer says yes: only the offered installer can win, only while the job is still being matched.
  async accept({ requestId, installerId, at }) {
    return withTransaction(async (conn) => {
      const [m] = await conn.execute("UPDATE install_matches SET status = 'accepted', responded_at = ? WHERE request_id = ? AND installer_id = ? AND status = 'offered'", [at, requestId, installerId]);
      if (m.affectedRows === 0) return false;
      const [r] = await conn.execute("UPDATE install_requests SET status = 'assigned', installer_id = ?, assigned_at = ? WHERE id = ? AND status = 'finding'", [installerId, at, requestId]);
      if (r.affectedRows === 0) return false;
      await event(conn, requestId, 'accepted', 'installer');
      return true;
    });
  },
  async jobsFor(installerId) {
    return (await query('SELECT * FROM install_requests WHERE installer_id = ? ORDER BY id DESC LIMIT 100', [installerId])).map(toRequest);
  },

  // ---- the visit and the build ----
  async step({ requestId, installerId, from, to, column, at, event: ev }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(`UPDATE install_requests SET status = ?, ${column} = ? WHERE id = ? AND installer_id = ? AND status = ?`, [to, at, requestId, installerId, from]);
      if (res.affectedRows === 0) return false;
      await event(conn, requestId, ev, 'installer');
      return true;
    });
  },
  async addPhoto({ requestId, uploaderId, kind, mime, size, data, remote }) {
    const res = await query(
      'INSERT INTO install_photos (request_id, uploader_id, kind, mime, bytes, data, remote_url, public_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [requestId, uploaderId, kind, mime, size, remote ? null : data, remote?.url ?? null, remote?.publicId ?? null]
    );
    return res.insertId;
  },
  async photos(requestId, kind = null) {
    const rows = await query(`SELECT id, kind, mime, bytes, uploader_id, created_at FROM install_photos WHERE request_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY id`, kind ? [requestId, kind] : [requestId]);
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind, mime: r.mime, bytes: Number(r.bytes), uploaderId: Number(r.uploader_id), createdAt: r.created_at }));
  },
  async photoFile(requestId, id) {
    const rows = await query('SELECT id, kind, mime, data, remote_url, public_id FROM install_photos WHERE id = ? AND request_id = ? LIMIT 1', [id, requestId]);
    const r = rows[0];
    return r ? { id: Number(r.id), kind: r.kind, mime: r.mime, data: r.data, remoteUrl: r.remote_url, publicId: r.public_id } : null;
  },
  async removePhoto(requestId, id, uploaderId) {
    const rows = await query('SELECT public_id FROM install_photos WHERE id = ? AND request_id = ? AND uploader_id = ?', [id, requestId, uploaderId]);
    if (!rows[0]) return null;
    await query('DELETE FROM install_photos WHERE id = ?', [id]);
    return { publicId: rows[0].public_id };
  },
  // The build is finished: the installer's report (summary and the pictures already uploaded) goes to the customer.
  async complete({ requestId, installerId, summary, at }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute("UPDATE install_requests SET status = 'installer_done', installer_done_at = ? WHERE id = ? AND installer_id = ? AND status = 'in_progress'", [at, requestId, installerId]);
      if (res.affectedRows === 0) return false;
      await conn.execute('INSERT INTO install_completions (request_id, installer_id, summary) VALUES (?, ?, ?)', [requestId, installerId, summary]);
      await event(conn, requestId, 'installer_done', 'installer');
      return true;
    });
  },
  async completion(requestId) {
    const rows = await query('SELECT summary, created_at FROM install_completions WHERE request_id = ? LIMIT 1', [requestId]);
    return rows[0] ? { summary: rows[0].summary, at: rows[0].created_at } : null;
  },
  // The customer (or the clock, or the admin) closes the job; the installer's pay becomes owed. Auto-close only with no problem raised.
  async confirm({ requestId, at, actor }) {
    return withTransaction(async (conn) => {
      const [r] = await conn.execute(`UPDATE install_requests SET status = 'completed', completed_at = ?, payout_amount = installer_payout, payout_status = 'owed' WHERE id = ? AND status = 'installer_done'${actor === 'system' ? ' AND problem_at IS NULL' : ''}`, [at, requestId]);
      if (r.affectedRows > 0) await event(conn, requestId, actor === 'system' ? 'auto_closed' : actor === 'admin' ? 'admin_confirmed' : 'confirmed', actor);
      return r.affectedRows > 0;
    });
  },
  async reportProblem({ requestId, note, at }) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute("UPDATE install_requests SET problem_at = ?, problem_note = ? WHERE id = ? AND status = 'installer_done' AND problem_at IS NULL", [at, note, requestId]);
      if (res.affectedRows === 0) return false;
      await event(conn, requestId, 'problem_reported', 'customer', note);
      return true;
    });
  },
  async dueForAutoClose(before) {
    return (await query("SELECT id FROM install_requests WHERE status = 'installer_done' AND problem_at IS NULL AND installer_done_at <= ? LIMIT 100", [before])).map((r) => Number(r.id));
  },
  // Jobs waiting for an installer with nobody recommended or offered (older jobs from before ranked matching, or a used-up list).
  async dueForAlert(before) {
    return (await query("SELECT r.* FROM install_requests r WHERE r.status = 'finding' AND r.alerted_at IS NULL AND r.open_at <= ? AND NOT EXISTS (SELECT 1 FROM install_matches m WHERE m.request_id = r.id AND m.status IN ('recommended','offered')) LIMIT 100", [before])).map(toRequest);
  },
  async markAlerted(id, at) {
    const r = await query('UPDATE install_requests SET alerted_at = ? WHERE id = ? AND alerted_at IS NULL', [at, id]);
    return r.affectedRows > 0;
  },
  // Cancels from the listed statuses, noting the refund the admin must send by hand and any payout the installer is owed.
  async cancel({ requestId, reason, at, refundAmount, from, actor, payoutAmount = 0 }) {
    return withTransaction(async (conn) => {
      const marks = from.map(() => '?').join(',');
      const [r] = await conn.execute(
        `UPDATE install_requests SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, refund_amount = ?, refund_needed = ?, payout_amount = ?, payout_status = ? WHERE id = ? AND status IN (${marks})`,
        [at, reason?.slice(0, 300) ?? null, refundAmount, refundAmount > 0 ? 1 : 0, payoutAmount, payoutAmount > 0 ? 'owed' : 'none', requestId, ...from]
      );
      if (r.affectedRows > 0) {
        await conn.execute("UPDATE install_matches SET status = 'passed', responded_at = ? WHERE request_id = ? AND status IN ('queued','recommended','offered')", [at, requestId]);
        await event(conn, requestId, 'cancelled', actor, reason ?? null);
      }
      return r.affectedRows > 0;
    });
  },
  async markPayoutPaid(requestId, at) {
    const r = await query("UPDATE install_requests SET payout_status = 'paid', payout_paid_at = ? WHERE id = ? AND payout_status = 'owed'", [at, requestId]);
    return r.affectedRows > 0;
  },
  async markRefunded(requestId) {
    const r = await query('UPDATE install_requests SET refund_needed = 0 WHERE id = ? AND refund_needed = 1', [requestId]);
    return r.affectedRows > 0;
  },
  async addReview({ requestId, customerId, installerId, rating, comment }) {
    try {
      await query('INSERT INTO install_reviews (request_id, customer_id, installer_id, rating, comment) VALUES (?, ?, ?, ?, ?)', [requestId, customerId, installerId, rating, comment ?? null]);
      return true;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  },
  async review(requestId) {
    const rows = await query('SELECT rating, comment, created_at FROM install_reviews WHERE request_id = ? LIMIT 1', [requestId]);
    return rows[0] ? { rating: Number(rows[0].rating), comment: rows[0].comment, at: rows[0].created_at } : null;
  },
  async ratingFor(installerId) {
    const rows = await query('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM (SELECT technician_id AS id, rating FROM repair_reviews UNION ALL SELECT installer_id, rating FROM install_reviews) v WHERE v.id = ?', [installerId]);
    return { average: rows[0].avg == null ? null : Math.round(Number(rows[0].avg) * 10) / 10, count: Number(rows[0].n) };
  },
  async earnings(installerId) {
    const rows = await query(
      `SELECT COALESCE(SUM(CASE WHEN payout_status = 'owed' THEN payout_amount END), 0) AS owed,
              COALESCE(SUM(CASE WHEN payout_status = 'paid' THEN payout_amount END), 0) AS paid,
              SUM(status = 'completed') AS jobs
       FROM install_requests WHERE installer_id = ?`,
      [installerId]
    );
    return { owed: Number(rows[0].owed), paid: Number(rows[0].paid), completedJobs: Number(rows[0].jobs ?? 0) };
  },
  async adminStats() {
    const rows = await query(
      `SELECT SUM(status = 'finding') AS finding, SUM(status IN ('assigned','on_the_way','on_site','in_progress')) AS active, SUM(status = 'installer_done') AS waiting,
              SUM(payout_status = 'owed') AS payouts_owed, SUM(refund_needed = 1) AS refunds, SUM(status = 'installer_done' AND problem_at IS NOT NULL) AS problems
       FROM install_requests`
    );
    const r = rows[0];
    return { finding: Number(r.finding ?? 0), active: Number(r.active ?? 0), waitingConfirm: Number(r.waiting ?? 0), payoutsOwed: Number(r.payouts_owed ?? 0), refundsNeeded: Number(r.refunds ?? 0), problems: Number(r.problems ?? 0) };
  },
};
