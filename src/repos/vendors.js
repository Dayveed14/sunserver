import { query, withTransaction } from '../db/pool.js';

export const vendorsRepo = {
  async getProfile(userId) {
    const rows = await query(
      'SELECT user_id, company_name, verification_status, registration_fee_status FROM vendor_profiles WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const r = rows[0];
    return r ? { userId: Number(r.user_id), companyName: r.company_name, verification: r.verification_status, registrationFee: r.registration_fee_status } : null;
  },

  async listForAdmin({ status }) {
    const rows = await query(
      `SELECT v.user_id, v.company_name, v.service_types, v.verification_status, v.registration_fee_status, v.created_at,
              u.email, u.full_name, u.phone, u.status AS account_status,
              (SELECT COUNT(*) FROM products p WHERE p.vendor_id = v.user_id AND p.status <> 'archived') AS products,
              (SELECT COUNT(*) FROM deals d WHERE d.vendor_id = v.user_id AND d.status = 'active') AS active_deals
       FROM vendor_profiles v JOIN users u ON u.id = v.user_id
       ${status ? 'WHERE v.verification_status = ?' : ''} ORDER BY v.created_at DESC LIMIT 200`,
      status ? [status] : []
    );
    return rows.map((r) => ({
      userId: Number(r.user_id), companyName: r.company_name, serviceTypes: r.service_types,
      verification: r.verification_status, registrationFee: r.registration_fee_status, createdAt: r.created_at, email: r.email, contactName: r.full_name,
      phone: r.phone, accountStatus: r.account_status, products: Number(r.products), activeDeals: Number(r.active_deals),
    }));
  },

  async setVerification(userId, status) {
    const res = await query('UPDATE vendor_profiles SET verification_status = ? WHERE user_id = ?', [status, userId]);
    return res.affectedRows > 0;
  },

  // ---- one-time registration fee ----
  // Returns this vendor's open payment, or starts one. The vendor row is locked while we look, so two taps give one payment.
  async openFeePayment({ vendorId, reference, amount }) {
    return withTransaction(async (conn) => {
      await conn.execute('SELECT user_id FROM vendor_profiles WHERE user_id = ? FOR UPDATE', [vendorId]);
      const [open] = await conn.execute("SELECT * FROM registration_payments WHERE vendor_id = ? AND status = 'initiated' ORDER BY id DESC LIMIT 1", [vendorId]);
      if (open[0]) return { payment: toFeePayment(open[0]), created: false };
      const [res] = await conn.execute('INSERT INTO registration_payments (vendor_id, reference, amount) VALUES (?, ?, ?)', [vendorId, reference, amount]);
      const [row] = await conn.execute('SELECT * FROM registration_payments WHERE id = ?', [res.insertId]);
      return { payment: toFeePayment(row[0]), created: true };
    });
  },
  async findFeePayment(reference) {
    const rows = await query('SELECT * FROM registration_payments WHERE reference = ? LIMIT 1', [reference]);
    return rows[0] ? toFeePayment(rows[0]) : null;
  },
  async latestFeePayment(vendorId) {
    const rows = await query('SELECT * FROM registration_payments WHERE vendor_id = ? ORDER BY id DESC LIMIT 1', [vendorId]);
    return rows[0] ? toFeePayment(rows[0]) : null;
  },
  async setFeePaymentAuth(id, { url, accessCode }) {
    await query('UPDATE registration_payments SET authorization_url = ?, access_code = ? WHERE id = ?', [url, accessCode, id]);
  },
  async failFeePayment(id) {
    await query("UPDATE registration_payments SET status = 'failed' WHERE id = ? AND status = 'initiated'", [id]);
  },
  // Counts the payment once, however many times it is reported: only the first caller changes anything.
  async settleFeePayment({ paymentId, vendorId, paidAt }) {
    return withTransaction(async (conn) => {
      const [claim] = await conn.execute("UPDATE registration_payments SET status = 'success', paid_at = ? WHERE id = ? AND status <> 'success'", [paidAt, paymentId]);
      if (claim.affectedRows === 0) return { won: false, replay: true };
      const [won] = await conn.execute("UPDATE vendor_profiles SET registration_fee_status = 'paid', registration_paid_at = ? WHERE user_id = ? AND registration_fee_status = 'unpaid'", [paidAt, vendorId]);
      return { won: won.affectedRows > 0, replay: false };
    });
  },
};

const toFeePayment = (r) => ({
  id: Number(r.id), vendorId: Number(r.vendor_id), reference: r.reference, amount: Number(r.amount), status: r.status,
  authorizationUrl: r.authorization_url, paidAt: r.paid_at,
});
