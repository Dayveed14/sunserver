import { query, withTransaction } from '../db/pool.js';

export const deliveryFeesModel = {
  async replaceForVendor(vendorId, rows) {
    await withTransaction(async (conn) => {
      await conn.execute('DELETE FROM vendor_delivery_fees WHERE vendor_id = ?', [vendorId]);
      for (const r of rows) {
        await conn.execute('INSERT INTO vendor_delivery_fees (vendor_id, area_id, distance_km, fee) VALUES (?, ?, ?, ?)', [vendorId, r.areaId, r.distanceKm, r.fee]);
      }
    });
  },

  async forVendors(vendorIds) {
    if (!vendorIds.length) return [];
    const rows = await query(
      `SELECT vendor_id, area_id, distance_km, fee FROM vendor_delivery_fees WHERE vendor_id IN (${vendorIds.map(() => '?').join(',')})`,
      vendorIds
    );
    return rows.map((r) => ({ vendorId: Number(r.vendor_id), areaId: r.area_id, distanceKm: Number(r.distance_km), fee: Number(r.fee) }));
  },

  // Every vendor who has a location, so prices can be worked out again after the delivery rules change.
  async vendorLocations() {
    const rows = await query(
      `SELECT a.user_id, a.state, a.area_id FROM addresses a JOIN users u ON u.id = a.user_id WHERE u.role = 'vendor'`
    );
    return rows.map((r) => ({ vendorId: Number(r.user_id), state: r.state, areaId: r.area_id }));
  },

  async vendorLocation(vendorId) {
    const rows = await query('SELECT state, area_id FROM addresses WHERE user_id = ? LIMIT 1', [vendorId]);
    return rows[0] ? { vendorId, state: rows[0].state, areaId: rows[0].area_id } : null;
  },
};
