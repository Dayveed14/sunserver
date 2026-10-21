import { query } from '../db/pool.js';

export const settingsModel = {
  async all() {
    const rows = await query('SELECT setting_key, value FROM pricing_settings');
    return Object.fromEntries(rows.map((r) => [r.setting_key, Number(r.value)]));
  },
  async set(key, value, adminId) {
    await query(
      `INSERT INTO pricing_settings (setting_key, value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
      [key, value, adminId]
    );
  },
  async remove(key) {
    await query('DELETE FROM pricing_settings WHERE setting_key = ?', [key]);
  },
};

export const auditModel = {
  async add({ adminId, action, target, detail }) {
    await query('INSERT INTO admin_audit (admin_id, action, target, detail) VALUES (?, ?, ?, ?)', [
      adminId, action, target, detail ? JSON.stringify(detail) : null,
    ]);
  },
  async recent(limit = 50) {
    const rows = await query(
      `SELECT a.id, a.action, a.target, a.detail, a.created_at, u.full_name AS admin_name
       FROM admin_audit a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT ${Number(limit) | 0}`
    );
    return rows.map((r) => ({
      id: Number(r.id), action: r.action, target: r.target, adminName: r.admin_name,
      detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail, at: r.created_at,
    }));
  },
};
