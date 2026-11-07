import { query } from '../db/pool.js';

export const interestModel = {
  // Same email twice for the same category is fine: it just stays one row.
  async add(category, email) {
    const res = await query('INSERT IGNORE INTO category_interest (category, email) VALUES (?, ?)', [category, email]);
    return res.affectedRows > 0;
  },
  async summary() {
    const counts = await query('SELECT category, COUNT(*) AS n FROM category_interest GROUP BY category');
    const recent = await query('SELECT category, email, created_at FROM category_interest ORDER BY id DESC LIMIT 100');
    return {
      counts: Object.fromEntries(counts.map((r) => [r.category, Number(r.n)])),
      recent: recent.map((r) => ({ category: r.category, email: r.email, at: r.created_at })),
    };
  },
};
