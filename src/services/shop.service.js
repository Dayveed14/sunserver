import { HttpError } from '../lib/httpError.js';
import { CORE_CATEGORIES, isCategory } from '../utils/productCategories.js';
import { SLA_RULES, estimateDelivery } from '../utils/sla.js';
import { findArea, stateName } from '../utils/areas.js';
import { leaseOptions } from '../utils/lease.js';
import { dealSpecs, plansOffered } from '../utils/matching.js';
import { publicDeal, publicProduct } from './offers.service.js';


// The public shop. Customers only see vendors in the state they are shopping for: there is no interstate delivery.
export function createShopService({ productsModel, dealsModel, feesService, config, sla = SLA_RULES, now = () => new Date() }) {
  const opt = { requireVerified: config.requireVerified };

  const needState = (state) => {
    if (state !== 'lagos' && state !== 'abuja') throw new HttpError(400, 'VALIDATION_ERROR', 'Choose Lagos or Abuja to see what is available.');
    return state;
  };

  // What the shopper sees about a vendor: where they are (area only, never the street) and the way there.
  async function withDelivery(vendor, base, dest) {
    const vendorArea = findArea(vendor.state, vendor.areaId);
    const out = { ...base, vendor: { ...base.vendor, stateName: stateName(vendor.state), areaName: vendorArea?.name ?? null } };
    if (!dest) return { ...out, delivery: null };
    const target = findArea(dest.state, dest.areaId);
    if (!target) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose an area to see delivery details.');
    if (vendor.state !== dest.state) {
      return { ...out, delivery: { available: false, reason: `${base.vendor.name} is in ${stateName(vendor.state)} and does not deliver to ${stateName(dest.state)}.` } };
    }
    const { fees, unreachable } = await feesService.quote([{ vendorId: vendor.vendorId, state: vendor.state, areaId: vendor.areaId }], dest);
    if (unreachable.length) return { ...out, delivery: { available: false, reason: 'This vendor cannot deliver to that area.' } };
    const f = fees.get(vendor.vendorId);
    const eta = estimateDelivery({ placedAt: now(), distanceKm: f.distanceKm, zone: f.zone, lines: 1 }, sla);
    return {
      ...out,
      delivery: {
        available: true,
        distanceKm: Math.round(f.distanceKm),
        fee: f.fee,
        toArea: target.name,
        promisedBy: eta.promisedBy,
        afterHours: eta.afterHours,
      },
    };
  }

  const vendorOf = (x) => ({ vendorId: x.vendorId, state: x.vendorState, areaId: x.vendorArea });
  const hasLocation = (x) => Boolean(x.vendorState && x.vendorArea);

  return {
    async listProducts({ state, category, q }) {
      needState(state);
      // "more" means every product that is not a panel, inverter or battery.
      if (category && category !== 'more' && !isCategory(category)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a valid product category.');
      }
      const products = await productsModel.listPublic({
        ...opt,
        state,
        category: category && category !== 'more' ? category : undefined,
        excludeCategories: category === 'more' ? CORE_CATEGORIES : undefined,
        search: q ?? '',
        limit: 100,
      });
      return { state, stateName: stateName(state), products: products.filter(hasLocation).map((p) => ({ ...publicProduct(p), vendor: { ...publicProduct(p).vendor, areaName: findArea(p.vendorState, p.vendorArea)?.name ?? null } })) };
    },

    async listDeals({ state }) {
      needState(state);
      const deals = await dealsModel.listActive({ ...opt, state });
      const usable = deals.filter((d) => hasLocation(d) && d.vendorVerification !== 'rejected' && !d.items.some((i) => i.productStatus === 'archived'));
      return {
        state,
        stateName: stateName(state),
        deals: usable.map((d) => ({
          ...publicDeal(d), specs: dealSpecs(d.items), plans: plansOffered(d).filter((p) => p !== 'eaas'), buyPrice: d.buyPrice,
          vendor: { ...publicDeal(d).vendor, areaName: findArea(d.vendorState, d.vendorArea)?.name ?? null },
        })),
      };
    },

    async productPage(id, dest) {
      const p = await productsModel.findPublic(id, opt);
      if (!p || !hasLocation(p)) throw new HttpError(404, 'NOT_FOUND', 'Product not found.');
      return withDelivery(vendorOf(p), { product: publicProduct(p), vendor: publicProduct(p).vendor }, dest).then(({ product, vendor, delivery }) => ({ product: { ...product, vendor }, delivery }));
    },

    async dealPage(id, dest) {
      const d = await dealsModel.findActive(id, opt);
      if (!d || !hasLocation(d) || d.items.some((i) => i.productStatus === 'archived')) throw new HttpError(404, 'NOT_FOUND', 'Deal not found.');
      const pub = publicDeal(d);
      const lease = d.buyPrice != null && d.leaseTerms ? leaseOptions(d.buyPrice, d.leaseTerms) : null;
      const r = await withDelivery(vendorOf(d), { deal: pub, vendor: pub.vendor }, dest);
      return { deal: { ...pub, vendor: r.vendor, specs: dealSpecs(d.items), plans: plansOffered(d).filter((p) => p !== 'eaas'), buyPrice: d.buyPrice, lease }, delivery: r.delivery };
    },
  };
}
