import { query } from '../db/pool.js';
import { imageUrl } from '../utils/images.js';

const toArticle = (r, withBody = true) => ({
  id: Number(r.id), slug: r.slug, title: r.title, summary: r.summary, ...(withBody ? { body: r.body } : {}),
  imageId: r.image_id == null ? null : Number(r.image_id), imageUrl: imageUrl(r.image_id), status: r.status,
  publishedAt: r.published_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

export const articlesModel = {
  async listPublished({ limit = 50, offset = 0 } = {}) {
    const rows = await query(`SELECT id, slug, title, summary, image_id, status, published_at, created_at, updated_at FROM articles WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT ${Number(limit) | 0} OFFSET ${Number(offset) | 0}`);
    return rows.map((r) => toArticle(r, false));
  },
  async findPublishedBySlug(slug) {
    const rows = await query("SELECT * FROM articles WHERE slug = ? AND status = 'published' LIMIT 1", [slug]);
    return rows[0] ? toArticle(rows[0]) : null;
  },
  async listAll() {
    const rows = await query('SELECT id, slug, title, summary, image_id, status, published_at, created_at, updated_at FROM articles ORDER BY id DESC LIMIT 300');
    return rows.map((r) => toArticle(r, false));
  },
  async findById(id) {
    const rows = await query('SELECT * FROM articles WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? toArticle(rows[0]) : null;
  },
  async slugTaken(slug, exceptId = null) {
    const rows = await query('SELECT id FROM articles WHERE slug = ? AND id <> ? LIMIT 1', [slug, exceptId ?? 0]);
    return rows.length > 0;
  },
  async create({ slug, title, summary, body, imageId, status, authorId }) {
    const res = await query(
      `INSERT INTO articles (slug, title, summary, body, image_id, status, author_id, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ${status === 'published' ? 'UTC_TIMESTAMP()' : 'NULL'})`,
      [slug, title, summary, body, imageId ?? null, status, authorId]
    );
    return Number(res.insertId);
  },
  // published_at is set the first time an article goes live and kept after that, so editing never reshuffles the blog.
  async update(id, { slug, title, summary, body, imageId, status }) {
    await query(
      `UPDATE articles SET slug = ?, title = ?, summary = ?, body = ?, image_id = ?, status = ?,
         published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN UTC_TIMESTAMP() ELSE published_at END WHERE id = ?`,
      [slug, title, summary, body, imageId ?? null, status, status, id]
    );
  },
  async remove(id) {
    const res = await query('DELETE FROM articles WHERE id = ?', [id]);
    return res.affectedRows > 0;
  },
};