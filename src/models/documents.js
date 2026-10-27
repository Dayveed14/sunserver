import { query } from '../db/pool.js';

const toDoc = (r) => ({ id: Number(r.id), userId: Number(r.user_id), kind: r.kind, label: r.label, mime: r.mime, bytes: Number(r.bytes), createdAt: r.created_at });

// Private files for verification. The bytes (or the secret Cloudinary address) are only ever read by `file()`.
export const documentsModel = {
  async create({ userId, kind, label, mime, size, data = null, remote = null, resourceType = 'image' }) {
    const res = await query(
      'INSERT INTO verification_documents (user_id, kind, label, mime, bytes, data, remote_url, public_id, resource_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, kind, label ?? null, mime, size, remote ? null : data, remote?.url ?? null, remote?.publicId ?? null, resourceType]
    );
    return res.insertId;
  },
  async listFor(userId) {
    const rows = await query('SELECT id, user_id, kind, label, mime, bytes, created_at FROM verification_documents WHERE user_id = ? ORDER BY id', [userId]);
    return rows.map(toDoc);
  },
  async file(id) {
    const rows = await query('SELECT id, user_id, mime, data, remote_url, public_id, resource_type FROM verification_documents WHERE id = ? LIMIT 1', [id]);
    const r = rows[0];
    return r ? { id: Number(r.id), userId: Number(r.user_id), mime: r.mime, data: r.data, remoteUrl: r.remote_url, publicId: r.public_id, resourceType: r.resource_type } : null;
  },
  async remove(id, userId) {
    const rows = await query('SELECT public_id, resource_type FROM verification_documents WHERE id = ? AND user_id = ?', [id, userId]);
    if (!rows[0]) return null;
    await query('DELETE FROM verification_documents WHERE id = ? AND user_id = ?', [id, userId]);
    return { publicId: rows[0].public_id, resourceType: rows[0].resource_type };
  },
  async count(userId) {
    const rows = await query('SELECT COUNT(*) AS n FROM verification_documents WHERE user_id = ?', [userId]);
    return Number(rows[0].n);
  },
};
