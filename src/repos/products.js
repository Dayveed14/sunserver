import { query } from '../db/pool.js';

const SELECT = `
  SELECT p.id, p.vendor_id, p.category, p.name, p.brand, p.rating, p.system_voltage, p.battery_type,
         p.price, p.in_stock, p.warranty_years, p.description, p.status, p.created_at,
         v.company_name AS vendor_name, v.verification_status AS vendor_verification
  FROM products p
  JOIN vendor_profiles v ON v.user_id = p.vendor_id`;

export const toProduct = (r) => ({
  id: Number(r.id),
  vendorId: Number(r.vendor_id),
  vendorName: r.vendor_name,
  vendorVerified: r.vendor_verification === 'verified',
  vendorVerification: r.vendor_verification,
  category: r.category,
  name: r.name,
  brand: r.brand,
  rating: Number(r.rating),
  systemVoltage: r.system_voltage,
  batteryType: r.battery_type,
  price: Number(r.price),
  inStock: Boolean(r.in_stock),
  warrantyYears: r.warranty_years,
  description: r.description,
  status: r.status,
  createdAt: r.created_at,
});

// Customers never see rejected vendors; if approval is required they only see verified ones.
const visibleVendor = (requireVerified) =>
  requireVerified ? "v.verification_status = 'verified'" : "v.verification_status <> 'rejected'";

const fields = (d) => [
  d.category, d.name, d.brand ?? null, d.rating, d.systemVoltage ?? null, d.batteryType ?? null,
  d.price, d.inStock ? 1 : 0, d.warrantyYears ?? null, d.description ?? null, d.status,
];

export const productsRepo = {
  async listByVendor(vendorId) {
    const rows = await query(
      `${SELECT} WHERE p.vendor_id = ? AND p.status <> 'archived' ORDER BY p.category, p.rating, p.id`,
      [vendorId]
    );
    return rows.map(toProduct);
  },

  async findOwned(id, vendorId) {
    const rows = await query(`${SELECT} WHERE p.id = ? AND p.vendor_id = ? AND p.status <> 'archived' LIMIT 1`, [id, vendorId]);
    return rows[0] ? toProduct(rows[0]) : null;
  },

  async findManyByIds(ids) {
    if (ids.length === 0) return [];
    const marks = ids.map(() => '?').join(',');
    const rows = await query(`${SELECT} WHERE p.id IN (${marks})`, ids);
    return rows.map(toProduct);
  },

  async create(vendorId, d) {
    const res = await query(
      `INSERT INTO products
        (vendor_id, category, name, brand, rating, system_voltage, battery_type, price, in_stock, warranty_years, description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [vendorId, ...fields(d)]
    );
    return res.insertId;
  },

  async update(id, vendorId, d) {
    const res = await query(
      `UPDATE products SET category = ?, name = ?, brand = ?, rating = ?, system_voltage = ?, battery_type = ?,
              price = ?, in_stock = ?, warranty_years = ?, description = ?, status = ?
       WHERE id = ? AND vendor_id = ? AND status <> 'archived'`,
      [...fields(d), id, vendorId]
    );
    return res.affectedRows > 0;
  },

  async archive(id, vendorId) {
    const res = await query("UPDATE products SET status = 'archived' WHERE id = ? AND vendor_id = ? AND status <> 'archived'", [id, vendorId]);
    return res.affectedRows > 0;
  },

  async countByVendor(vendorId) {
    const rows = await query("SELECT COUNT(*) AS n FROM products WHERE vendor_id = ? AND status <> 'archived'", [vendorId]);
    return Number(rows[0].n);
  },

  // Everything customers can pick from in the DIY builder (the matching rules narrow it down).
  async listBuyable({ requireVerified }) {
    const rows = await query(
      `${SELECT} WHERE p.status = 'active' AND p.in_stock = 1 AND ${visibleVendor(requireVerified)} LIMIT 2000`
    );
    return rows.map(toProduct);
  },

  // The public shop.
  async listPublic({ requireVerified, category, search, limit }) {
    const where = ["p.status = 'active'", visibleVendor(requireVerified)];
    const params = [];
    if (category) {
      where.push('p.category = ?');
      params.push(category);
    }
    if (search) {
      where.push('(p.name LIKE ? OR p.brand LIKE ? OR v.company_name LIKE ?)');
      const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
      params.push(like, like, like);
    }
    const rows = await query(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY p.in_stock DESC, p.category, p.rating, p.price LIMIT ${Number(limit) || 100}`,
      params
    );
    return rows.map(toProduct);
  },
};
