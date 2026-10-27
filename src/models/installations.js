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
});
const toPayment = (r) => ({ id: Number(r.id), requestId: Number(r.request_id), reference: r.reference, amount: Number(r.amount), status: r.status, authorizationUrl: r.authorization_url, paidAt: r.paid_at });

const event = (conn, requestId, type, actor, note = null) =>
  conn.execute('INSERT INTO install_events (request_id, type, actor, note) VALUES (?, ?, ?, ?)', [requestId, type, actor, note]);

export const installationsModel = {
  async create(d) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(
        `INSERT INTO install_requests (public_ref, customer_id, description, system_kw, band_id, band_label, price, installer_payout, state, area_id, address_line, contact_name, contact_phone, preferred_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.ref, d.customerId, d.description, d.systemKw, d.bandId, d.bandLabel, d.price, d.installerPayout, d.state, d.areaId, d.addressLine, d.contactName, d.contactPhone, d.preferredDate]
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
  async listForAdmin({ status } = {}) {
    const rows = await query(
      `SELECT r.*, c.full_name AS customer_name, c.email AS customer_email, i.full_name AS installer_name
       FROM install_requests r JOIN users c ON c.id = r.customer_id LEFT JOIN users i ON i.id = r.installer_id
       ${status ? 'WHERE r.status = ?' : "WHERE r.status <> 'quote'"} ORDER BY r.id DESC LIMIT 200`,
      status ? [status] : []
    );
    return rows.map((r) => ({ ...toRequest(r), customerName: r.customer_name, customerEmail: r.customer_email, installerName: r.installer_name }));
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
      const [won] = await conn.execute("UPDATE install_requests SET status = 'open', open_at = ? WHERE id = ? AND status IN ('quote','awaiting_payment')", [paidAt, requestId]);
      if (won.affectedRows > 0) await event(conn, requestId, 'paid', 'customer');
      return { replay: false, opened: won.affectedRows > 0 };
    });
  },

  // ---- dispatch ----
  // Approved, active installers whose address is in the job's state.
  async eligibleInstallers(state) {
    const rows = await query(
      `SELECT u.id, u.email, u.full_name FROM users u
       JOIN installer_profiles i ON i.user_id = u.id AND i.verification_status = 'verified'
       JOIN addresses a ON a.user_id = u.id
       WHERE u.role = 'installer' AND u.status = 'active' AND u.email_verified_at IS NOT NULL AND a.state = ?`,
      [state]
    );
    return rows.map((r) => ({ id: Number(r.id), email: r.email, fullName: r.full_name }));
  },
  async addOffers(requestId, installerIds) {
    for (const id of installerIds) {
      await query('INSERT IGNORE INTO install_offers (request_id, installer_id) VALUES (?, ?)', [requestId, id]);
    }
  },
  // Open jobs this installer was sent and has not answered.
  async openOffersFor(installerId) {
    const rows = await query(
      `SELECT r.* FROM install_offers o JOIN install_requests r ON r.id = o.request_id
       WHERE o.installer_id = ? AND o.response = 'pending' AND r.status = 'open' ORDER BY r.id DESC LIMIT 50`,
      [installerId]
    );
    return rows.map(toRequest);
  },
  async hasOffer(requestId, installerId) {
    const rows = await query('SELECT response FROM install_offers WHERE request_id = ? AND installer_id = ? LIMIT 1', [requestId, installerId]);
    return rows[0]?.response ?? null;
  },
  async jobsFor(installerId) {
    const rows = await query("SELECT * FROM install_requests WHERE installer_id = ? ORDER BY id DESC LIMIT 100", [installerId]);
    return rows.map(toRequest);
  },
  // The first installer to get here wins: the job moves open → assigned only once.
  async accept({ requestId, installerId, at }) {
    return withTransaction(async (conn) => {
      const [win] = await conn.execute("UPDATE install_requests SET status = 'assigned', installer_id = ?, assigned_at = ? WHERE id = ? AND status = 'open'", [installerId, at, requestId]);
      if (win.affectedRows === 0) return { won: false };
      await conn.execute("UPDATE install_offers SET response = 'accepted', responded_at = ? WHERE request_id = ? AND installer_id = ?", [at, requestId, installerId]);
      await conn.execute("UPDATE install_offers SET response = 'lost', responded_at = ? WHERE request_id = ? AND installer_id <> ? AND response = 'pending'", [at, requestId, installerId]);
      await event(conn, requestId, 'accepted', 'installer');
      return { won: true };
    });
  },
  async decline({ requestId, installerId, at }) {
    const res = await query("UPDATE install_offers SET response = 'declined', responded_at = ? WHERE request_id = ? AND installer_id = ? AND response = 'pending'", [at, requestId, installerId]);
    if (res.affectedRows > 0) await installationsModel.addEvent(requestId, 'declined', 'installer');
    const rows = await query("SELECT COUNT(*) AS n FROM install_offers WHERE request_id = ? AND response = 'pending'", [requestId]);
    return { declined: res.affectedRows > 0, remaining: Number(rows[0].n) };
  },
  async markDone({ requestId, installerId, at }) {
    return withTransaction(async (conn) => {
      const [r] = await conn.execute("UPDATE install_requests SET status = 'installer_done', installer_done_at = ? WHERE id = ? AND installer_id = ? AND status = 'assigned'", [at, requestId, installerId]);
      if (r.affectedRows > 0) await event(conn, requestId, 'installer_done', 'installer');
      return r.affectedRows > 0;
    });
  },
  // The customer (or the clock) closes the job; the installer's pay becomes owed.
  async complete({ requestId, at, actor }) {
    return withTransaction(async (conn) => {
      const [r] = await conn.execute("UPDATE install_requests SET status = 'completed', completed_at = ?, payout_status = 'owed' WHERE id = ? AND status = 'installer_done'", [at, requestId]);
      if (r.affectedRows > 0) await event(conn, requestId, actor === 'system' ? 'auto_closed' : 'confirmed', actor);
      return r.affectedRows > 0;
    });
  },
  async dueForAutoClose(before) {
    const rows = await query("SELECT id FROM install_requests WHERE status = 'installer_done' AND installer_done_at <= ? LIMIT 100", [before]);
    return rows.map((r) => Number(r.id));
  },
  async dueForAlert(before) {
    const rows = await query("SELECT * FROM install_requests WHERE status = 'open' AND alerted_at IS NULL AND open_at <= ? LIMIT 100", [before]);
    return rows.map(toRequest);
  },
  async markAlerted(id, at) {
    const r = await query('UPDATE install_requests SET alerted_at = ? WHERE id = ? AND alerted_at IS NULL', [at, id]);
    return r.affectedRows > 0;
  },
  async cancel({ requestId, reason, at, refundNeeded, from }) {
    return withTransaction(async (conn) => {
      const marks = from.map(() => '?').join(',');
      const [r] = await conn.execute(
        `UPDATE install_requests SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, refund_needed = ? WHERE id = ? AND status IN (${marks})`,
        [at, reason?.slice(0, 300) ?? null, refundNeeded ? 1 : 0, requestId, ...from]
      );
      if (r.affectedRows > 0) {
        await conn.execute("UPDATE install_offers SET response = 'lost' WHERE request_id = ? AND response = 'pending'", [requestId]);
        await event(conn, requestId, 'cancelled', refundNeeded ? 'admin' : 'customer', reason ?? null);
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
  async earnings(installerId) {
    const rows = await query(
      `SELECT COALESCE(SUM(CASE WHEN payout_status = 'owed' THEN installer_payout END), 0) AS owed,
              COALESCE(SUM(CASE WHEN payout_status = 'paid' THEN installer_payout END), 0) AS paid,
              SUM(status = 'completed') AS jobs
       FROM install_requests WHERE installer_id = ?`,
      [installerId]
    );
    return { owed: Number(rows[0].owed), paid: Number(rows[0].paid), completedJobs: Number(rows[0].jobs ?? 0) };
  },
  async adminStats() {
    const rows = await query(
      `SELECT SUM(status = 'open') AS open, SUM(status = 'assigned') AS assigned, SUM(status = 'installer_done') AS waiting,
              SUM(payout_status = 'owed') AS payouts_owed, SUM(refund_needed = 1) AS refunds
       FROM install_requests`
    );
    const r = rows[0];
    return { open: Number(r.open ?? 0), assigned: Number(r.assigned ?? 0), waitingConfirm: Number(r.waiting ?? 0), payoutsOwed: Number(r.payouts_owed ?? 0), refundsNeeded: Number(r.refunds ?? 0) };
  },
};
