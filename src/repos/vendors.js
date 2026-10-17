import { query } from '../db/pool.js';

export const vendorsRepo = {
  async getProfile(userId) {
    const rows = await query(
      'SELECT user_id, company_name, verification_status FROM vendor_profiles WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const r = rows[0];
    return r ? { userId: Number(r.user_id), companyName: r.company_name, verification: r.verification_status } : null;
  },

  async listForAdmin({ status }) {
    const rows = await query(
      `SELECT v.user_id, v.company_name, v.service_types, v.verification_status, v.created_at,
              u.email, u.full_name, u.phone, u.status AS account_status,
              (SELECT COUNT(*) FROM products p WHERE p.vendor_id = v.user_id AND p.status <> 'archived') AS products,
              (SELECT COUNT(*) FROM deals d WHERE d.vendor_id = v.user_id AND d.status = 'active') AS active_deals
       FROM vendor_profiles v JOIN users u ON u.id = v.user_id
       ${status ? 'WHERE v.verification_status = ?' : ''} ORDER BY v.created_at DESC LIMIT 200`,
      status ? [status] : []
    );
    return rows.map((r) => ({
      userId: Number(r.user_id), companyName: r.company_name, serviceTypes: r.service_types,
      verification: r.verification_status, createdAt: r.created_at, email: r.email, contactName: r.full_name,
      phone: r.phone, accountStatus: r.account_status, products: Number(r.products), activeDeals: Number(r.active_deals),
    }));
  },

  async setVerification(userId, status) {
    const res = await query('UPDATE vendor_profiles SET verification_status = ? WHERE user_id = ?', [status, userId]);
    return res.affectedRows > 0;
  },
};
