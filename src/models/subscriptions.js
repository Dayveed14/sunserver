import { query, withTransaction } from '../db/pool.js';
import { extend } from '../utils/subscription.js';

const toPayment = (r) => ({
  id: Number(r.id), vendorId: Number(r.vendor_id), reference: r.reference, amount: Number(r.amount), months: Number(r.months), status: r.status,
  authorizationUrl: r.authorization_url, createdAt: r.created_at, paidAt: r.paid_at, paidUntil: r.paid_until,
});

// Subscription state and payments. Every payment is counted once: the first caller to flip it to 'success' extends the
// vendor's paid-up date, in the same transaction, with the vendor row locked.
export const subscriptionsModel = {
  async profile(vendorId) {
    const rows = await query(
      `SELECT v.user_id, v.company_name, v.vendor_type, v.verification_status, v.subscription_paid_until, u.email, u.full_name
       FROM vendor_profiles v JOIN users u ON u.id = v.user_id WHERE v.user_id = ? LIMIT 1`, [vendorId]);
    const r = rows[0];
    return r ? { vendorId: Number(r.user_id), companyName: r.company_name, vendorType: r.vendor_type, verification: r.verification_status, paidUntil: r.subscription_paid_until, email: r.email, contactName: r.full_name } : null;
  },

  async createPayment({ vendorId, reference, amount, months }) {
    const res = await query('INSERT INTO subscription_payments (vendor_id, reference, amount, months) VALUES (?, ?, ?, ?)', [vendorId, reference, amount, months]);
    const rows = await query('SELECT * FROM subscription_payments WHERE id = ?', [res.insertId]);
    return toPayment(rows[0]);
  },
  async find(reference) {
    const rows = await query('SELECT * FROM subscription_payments WHERE reference = ? LIMIT 1', [reference]);
    return rows[0] ? toPayment(rows[0]) : null;
  },
  async setAuth(id, { url, accessCode }) {
    await query('UPDATE subscription_payments SET authorization_url = ?, access_code = ? WHERE id = ?', [url, accessCode, id]);
  },
  async fail(id) {
    await query("UPDATE subscription_payments SET status = 'failed' WHERE id = ? AND status = 'initiated'", [id]);
  },
  async history(vendorId, limit = 24) {
    const rows = await query(`SELECT * FROM subscription_payments WHERE vendor_id = ? AND status = 'success' ORDER BY id DESC LIMIT ${Number(limit) | 0}`, [vendorId]);
    return rows.map(toPayment);
  },

  // Counts the payment once and moves the paid-up date forward. `days` comes from the payment's months, never from the browser.
  async settle({ paymentId, vendorId, days, paidAt }) {
    return withTransaction(async (conn) => {
      const [claim] = await conn.execute("UPDATE subscription_payments SET status = 'success', paid_at = ? WHERE id = ? AND status <> 'success'", [paidAt, paymentId]);
      if (claim.affectedRows === 0) return { replay: true };
      const [rows] = await conn.execute('SELECT subscription_paid_until FROM vendor_profiles WHERE user_id = ? FOR UPDATE', [vendorId]);
      const until = extend(rows[0]?.subscription_paid_until ?? null, days, paidAt);
      await conn.execute('UPDATE vendor_profiles SET subscription_paid_until = ? WHERE user_id = ?', [until, vendorId]);
      await conn.execute('UPDATE subscription_payments SET paid_until = ? WHERE id = ?', [until, paymentId]);
      return { replay: false, paidUntil: until };
    });
  },

  // Free days from the admin (a launch gift, a goodwill extension).
  async grant(vendorId, days, now) {
    return withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT subscription_paid_until FROM vendor_profiles WHERE user_id = ? FOR UPDATE', [vendorId]);
      if (!rows[0]) return null;
      const until = extend(rows[0].subscription_paid_until, days, now);
      await conn.execute('UPDATE vendor_profiles SET subscription_paid_until = ? WHERE user_id = ?', [until, vendorId]);
      return until;
    });
  },
  // The same gift to every verified vendor, in one statement. Only vendors who are not already paid up beyond that.
  async grantAll(days, now, vendorType = null) {
    const until = extend(null, days, now);
    const res = await query(
      `UPDATE vendor_profiles SET subscription_paid_until = ? WHERE verification_status = 'verified'
       AND (subscription_paid_until IS NULL OR subscription_paid_until < ?)${vendorType ? ' AND vendor_type = ?' : ''}`,
      vendorType ? [until, until, vendorType] : [until, until]);
    return { updated: res.affectedRows, until };
  },

  async listForAdmin() {
    const rows = await query(
      `SELECT v.user_id, v.company_name, v.vendor_type, v.verification_status, v.subscription_paid_until, u.email, u.full_name, u.status AS user_status,
              (SELECT MAX(p.paid_at) FROM subscription_payments p WHERE p.vendor_id = v.user_id AND p.status = 'success') AS last_paid_at
       FROM vendor_profiles v JOIN users u ON u.id = v.user_id ORDER BY v.user_id DESC LIMIT 500`);
    return rows.map((r) => ({
      vendorId: Number(r.user_id), companyName: r.company_name, vendorType: r.vendor_type, verification: r.verification_status,
      paidUntil: r.subscription_paid_until, email: r.email, contactName: r.full_name, accountStatus: r.user_status, lastPaidAt: r.last_paid_at,
    }));
  },

  // For the reminder emails. `from`..`to` is the window the paid-up date must fall in; `column` records that we already told them.
  async dueBetween(from, to) {
    const rows = await query(
      `SELECT v.user_id, v.vendor_type, v.subscription_paid_until, u.email, u.full_name FROM vendor_profiles v JOIN users u ON u.id = v.user_id
       WHERE v.verification_status = 'verified' AND u.status = 'active' AND v.subscription_paid_until BETWEEN ? AND ?
       AND (v.sub_reminded_for IS NULL OR v.sub_reminded_for <> v.subscription_paid_until) LIMIT 500`, [from, to]);
    return rows.map((r) => ({ vendorId: Number(r.user_id), vendorType: r.vendor_type, paidUntil: r.subscription_paid_until, email: r.email, fullName: r.full_name }));
  },
  async markReminded(vendorId, paidUntil) {
    await query('UPDATE vendor_profiles SET sub_reminded_for = ? WHERE user_id = ?', [paidUntil, vendorId]);
  },
  async lapsedBetween(from, to) {
    const rows = await query(
      `SELECT v.user_id, v.vendor_type, v.subscription_paid_until, u.email, u.full_name FROM vendor_profiles v JOIN users u ON u.id = v.user_id
       WHERE v.verification_status = 'verified' AND u.status = 'active' AND v.subscription_paid_until BETWEEN ? AND ?
       AND (v.sub_lapsed_notified_for IS NULL OR v.sub_lapsed_notified_for <> v.subscription_paid_until) LIMIT 500`, [from, to]);
    return rows.map((r) => ({ vendorId: Number(r.user_id), vendorType: r.vendor_type, paidUntil: r.subscription_paid_until, email: r.email, fullName: r.full_name }));
  },
  async markLapsedNotified(vendorId, paidUntil) {
    await query('UPDATE vendor_profiles SET sub_lapsed_notified_for = ? WHERE user_id = ?', [paidUntil, vendorId]);
  },
};
