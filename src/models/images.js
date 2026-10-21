import { query } from '../db/pool.js';

export const imagesModel = {
  // Pictures live on Cloudinary (`remote`) when it is configured; otherwise the bytes are kept here.
  async create({ ownerId, mime, size, data = null, remote = null }) {
    const res = await query('INSERT INTO images (owner_id, mime, bytes, data, remote_url, public_id) VALUES (?, ?, ?, ?, ?, ?)',
      [ownerId, mime, size ?? data?.length ?? 0, remote ? null : data, remote?.url ?? null, remote?.publicId ?? null]);
    return res.insertId;
  },
  async get(id) {
    const rows = await query('SELECT mime, data, remote_url FROM images WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? { mime: rows[0].mime, data: rows[0].data, remoteUrl: rows[0].remote_url } : null;
  },
  async exists(id) {
    const rows = await query('SELECT id FROM images WHERE id = ? LIMIT 1', [id]);
    return rows.length > 0;
  },
  async ownedBy(id, ownerId) {
    const rows = await query('SELECT id FROM images WHERE id = ? AND owner_id = ? LIMIT 1', [id, ownerId]);
    return rows.length > 0;
  },
};
