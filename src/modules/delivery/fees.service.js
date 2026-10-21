import { DELIVERY_RULES, buildFeeMatrix, quoteTrip } from './delivery.js';
import { findArea } from '../geo/areas.js';

// Keeps each vendor's delivery prices to every area, and answers "what does delivery cost from these vendors to here?".
// The repo is injected so the rules can be tested without a database.
export function createFeesService({ repo, rules = DELIVERY_RULES }) {
  // Work out and save the prices from this vendor's location to every area in their state.
  async function refreshVendor(vendorId, location) {
    const loc = location ?? (await repo.vendorLocation(vendorId));
    if (!loc) return 0;
    const rows = buildFeeMatrix(loc.state, loc.areaId, rules);
    await repo.replaceForVendor(vendorId, rows);
    return rows.length;
  }

  async function recomputeAll() {
    const all = await repo.vendorLocations();
    for (const v of all) await refreshVendor(v.vendorId, v);
    return all.length;
  }

  // One price per vendor for delivering to `destination` ({ state, areaId }). Vendors in another state cannot deliver.
  // Returns { fees: Map(vendorId -> { fee, distanceKm, zone }), unreachable: [vendorId] }.
  async function quote(vendors, destination) {
    const dest = findArea(destination.state, destination.areaId);
    const saved = await repo.forVendors(vendors.map((v) => v.vendorId));
    const byVendor = new Map();
    for (const row of saved) if (row.areaId === destination.areaId) byVendor.set(row.vendorId, row);

    const fees = new Map();
    const unreachable = [];
    for (const v of vendors) {
      if (!dest || v.state !== destination.state) { unreachable.push(v.vendorId); continue; }
      let row = byVendor.get(v.vendorId);
      if (!row) {
        // Not saved yet (an older vendor, or one who has just moved): work it out now and keep it.
        await refreshVendor(v.vendorId, { vendorId: v.vendorId, state: v.state, areaId: v.areaId });
        const trip = quoteTrip({ from: { state: v.state, areaId: v.areaId }, to: destination }, rules);
        row = { fee: trip.fee, distanceKm: trip.distanceKm };
      }
      fees.set(v.vendorId, { fee: row.fee, distanceKm: row.distanceKm, zone: dest.zone });
    }
    return { fees, unreachable };
  }

  return { refreshVendor, recomputeAll, quote };
}
