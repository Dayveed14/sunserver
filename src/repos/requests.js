import { query } from '../db/pool.js';

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const num = (v) => (v === null || v === undefined ? null : Number(v));

const toRequest = (r) => ({
  id: Number(r.id),
  customerId: Number(r.customer_id),
  vendorId: Number(r.vendor_id),
  assessmentId: num(r.assessment_id),
  kind: r.kind,
  dealId: num(r.deal_id),
  plan: r.plan,
  upfrontPrice: num(r.upfront_price),
  monthlyPrice: num(r.monthly_price),
  summary: parseJson(r.summary_json),
  message: r.message,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const requestsRepo = {
  async create(r) {
    const res = await query(
      `INSERT INTO quote_requests
        (customer_id, vendor_id, assessment_id, kind, deal_id, plan, upfront_price, monthly_price, summary_json, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.customerId, r.vendorId, r.assessmentId ?? null, r.kind, r.dealId ?? null, r.plan,
        r.upfrontPrice ?? null, r.monthlyPrice ?? null, JSON.stringify(r.summary), r.message ?? null,
      ]
    );
    return res.insertId;
  },

  // A customer shouldn't be able to flood a vendor with the same request.
  async findOpenDuplicate({ customerId, vendorId, assessmentId, kind, dealId, plan }) {
    const rows = await query(
      `SELECT id FROM quote_requests
       WHERE customer_id = ? AND vendor_id = ? AND kind = ? AND plan = ?
         AND (assessment_id <=> ?) AND (deal_id <=> ?) AND status IN ('new', 'contacted') LIMIT 1`,
      [customerId, vendorId, kind, plan, assessmentId ?? null, dealId ?? null]
    );
    return rows[0] ? Number(rows[0].id) : null;
  },

  async listForVendor(vendorId) {
    const rows = await query(
      `SELECT q.*, u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
              u.role AS customer_role, b.company_name AS customer_company
       FROM quote_requests q
       JOIN users u ON u.id = q.customer_id
       LEFT JOIN business_profiles b ON b.user_id = u.id
       WHERE q.vendor_id = ? ORDER BY q.id DESC LIMIT 200`,
      [vendorId]
    );
    return rows.map((r) => ({
      ...toRequest(r),
      customer: {
        name: r.customer_name,
        email: r.customer_email,
        phone: r.customer_phone,
        role: r.customer_role,
        company: r.customer_company,
      },
    }));
  },

  async listForCustomer(customerId) {
    const rows = await query(
      `SELECT q.*, v.company_name AS vendor_name
       FROM quote_requests q JOIN vendor_profiles v ON v.user_id = q.vendor_id
       WHERE q.customer_id = ? ORDER BY q.id DESC LIMIT 200`,
      [customerId]
    );
    return rows.map((r) => ({ ...toRequest(r), vendorName: r.vendor_name }));
  },

  async setStatusForVendor(id, vendorId, status) {
    const res = await query(
      "UPDATE quote_requests SET status = ? WHERE id = ? AND vendor_id = ? AND status <> 'cancelled'",
      [status, id, vendorId]
    );
    return res.affectedRows > 0;
  },

  async cancelForCustomer(id, customerId) {
    const res = await query(
      "UPDATE quote_requests SET status = 'cancelled' WHERE id = ? AND customer_id = ? AND status IN ('new', 'contacted')",
      [id, customerId]
    );
    return res.affectedRows > 0;
  },

  async countNewForVendor(vendorId) {
    const rows = await query("SELECT COUNT(*) AS n FROM quote_requests WHERE vendor_id = ? AND status = 'new'", [vendorId]);
    return Number(rows[0].n);
  },
};
