import { HttpError } from '../lib/httpError.js';
import { isCore } from '../utils/productCategories.js';
import { EAAS_RULES, computeEaas, componentsFromItems } from '../utils/eaas.js';
import { leaseOptions } from '../utils/lease.js';
import { checkDealComposition, dealSpecs, plansOffered } from '../utils/matching.js';

// Vendor-side rules: what a vendor may list and how a deal must be put together.
// Models are injected so the rules can be tested without a database.
export function createCatalogService({ productsModel, dealsModel, requestsModel, vendorsModel, imagesModel = null }) {
  const notFound = (what) => new HttpError(404, 'NOT_FOUND', `${what} not found.`);
  // Energy-as-a-Service ties a vendor to a customer for years, so only registered companies may offer it.
  const assertCompany = async (vendorId) => {
    const p = await vendorsModel.getProfile(vendorId);
    if (p?.vendorType !== 'company') throw new HttpError(403, 'EAAS_COMPANY_ONLY', 'Only company vendors can offer Energy-as-a-Service. Register as a company and upload your CAC to unlock it.');
  };

  // Turns the vendor's picks into full items, making sure every product is theirs and still listed.
  async function resolveItems(vendorId, items) {
    const owned = await productsModel.listByVendor(vendorId);
    const byId = new Map(owned.map((p) => [p.id, p]));
    const resolved = [];
    for (const { productId, qty } of items) {
      const p = byId.get(productId);
      // Deals are complete solar systems: only panels, inverters and batteries go into them.
      if (p && !isCore(p.category)) {
        throw new HttpError(400, 'INVALID_DEAL', 'Deals can only include solar panels, inverters and batteries. Sell other products on their own in the shop.', {
          fields: { items: 'Pick a panel, an inverter and a battery.' },
        });
      }
      if (!p) {
        throw new HttpError(400, 'INVALID_DEAL', 'One of the products is not in your catalogue.', {
          fields: { items: 'Pick products from your own catalogue.' },
        });
      }
      resolved.push({
        productId: p.id, name: p.name, brand: p.brand, category: p.category, rating: p.rating,
        systemVoltage: p.systemVoltage, price: p.price, productStatus: p.status, qty,
      });
    }
    const problems = checkDealComposition(resolved);
    if (problems.length) {
      throw new HttpError(400, 'INVALID_DEAL', problems[0].message, {
        fields: { items: problems.map((e) => e.message).join(' ') },
      });
    }
    return resolved;
  }

  // A vendor can only attach a picture they uploaded themselves.
  async function checkImage(vendorId, imageId) {
    if (imageId == null || !imagesModel) return;
    if (!(await imagesModel.ownedBy(imageId, vendorId))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'That picture was not found. Upload it again.', { fields: { imageId: 'Upload the picture again.' } });
    }
  }

  const withSpecs = (deal) => ({ ...deal, specs: dealSpecs(deal.items), plans: plansOffered(deal) });

  return {
    async summary(vendorId) {
      const [profile, products, activeDeals, newRequests] = await Promise.all([
        vendorsModel.getProfile(vendorId),
        productsModel.countByVendor(vendorId),
        dealsModel.countActiveByVendor(vendorId),
        requestsModel.countNewForVendor(vendorId),
      ]);
      return { verification: profile?.verification ?? 'pending', vendorType: profile?.vendorType ?? 'seller', note: profile?.note ?? null, products, activeDeals, newRequests };
    },

    listProducts: (vendorId) => productsModel.listByVendor(vendorId),

    async createProduct(vendorId, data) {
      await checkImage(vendorId, data.imageId);
      const id = await productsModel.create(vendorId, data);
      if (data.imageId != null) await productsModel.setImage?.(id, data.imageId);
      return productsModel.findOwned(id, vendorId);
    },

    async updateProduct(vendorId, id, data) {
      const existing = await productsModel.findOwned(id, vendorId);
      if (!existing) throw notFound('Product');
      // Changing a product's type would silently change every deal that uses it.
      if (existing.category !== data.category) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'A product\'s type cannot be changed. Add a new product instead.', {
          fields: { category: 'Type cannot be changed.' },
        });
      }
      await checkImage(vendorId, data.imageId);
      await productsModel.update(id, vendorId, data);
      if (data.imageId !== undefined) await productsModel.setImage?.(id, data.imageId);
      return productsModel.findOwned(id, vendorId);
    },

    async archiveProduct(vendorId, id) {
      if (!(await productsModel.archive(id, vendorId))) throw notFound('Product');
    },

    async listDeals(vendorId) {
      return (await dealsModel.listByVendor(vendorId)).map(withSpecs);
    },

    async createDeal(vendorId, data) {
      if (data.eaas) await assertCompany(vendorId);
      const items = await resolveItems(vendorId, data.items);
      await checkImage(vendorId, data.imageId);
      const id = await dealsModel.create(vendorId, { ...data, items });
      if (data.imageId != null) await dealsModel.setImage?.(id, data.imageId);
      return withSpecs(await dealsModel.findOwned(id, vendorId));
    },

    async updateDeal(vendorId, id, data) {
      if (!(await dealsModel.findOwned(id, vendorId))) throw notFound('Deal');
      if (data.eaas) await assertCompany(vendorId);
      const items = await resolveItems(vendorId, data.items);
      await checkImage(vendorId, data.imageId);
      await dealsModel.update(id, vendorId, { ...data, items });
      await dealsModel.setImage?.(id, data.imageId ?? null);
      return withSpecs(await dealsModel.findOwned(id, vendorId));
    },

    async setDealStatus(vendorId, id, status) {
      const deal = await dealsModel.findOwned(id, vendorId);
      if (!deal) throw notFound('Deal');
      if (status === 'active') {
        if (deal.items.some((i) => i.productStatus === 'archived')) {
          throw new HttpError(400, 'INVALID_DEAL', 'This deal uses a product you removed. Edit the deal first.');
        }
        if (plansOffered(deal).length === 0) {
          throw new HttpError(400, 'INVALID_DEAL', 'Set a price for at least one way to pay before publishing.');
        }
      }
      await dealsModel.setStatus(id, vendorId, status);
      return withSpecs(await dealsModel.findOwned(id, vendorId));
    },

    async archiveDeal(vendorId, id) {
      if (!(await dealsModel.findOwned(id, vendorId))) throw notFound('Deal');
      // 'archived' keeps old requests that point at it intact.
      await dealsModel.setStatus(id, vendorId, 'archived');
    },

    // Shows a vendor what their EaaS terms would charge a home and a business, before they publish.
    async previewEaas(vendorId, { items, eaas }) {
      await assertCompany(vendorId);
      const resolved = await resolveItems(vendorId, items);
      const terms = {
        components: componentsFromItems(resolved.map((i) => ({ ...i, batteryType: i.batteryType ?? null })), eaas.equipmentCost ?? null),
        installationCost: eaas.installationCost,
        installationMode: eaas.installationMode,
        tenorMonths: eaas.tenorMonths,
        annualReturn: eaas.annualReturnPct / 100,
      };
      return { home: computeEaas({ ...terms, segment: 'home' }), business: computeEaas({ ...terms, segment: 'business' }) };
    },

    // What each plan length would cost, shown to a vendor while they set up a lease.
    leasePreview: (data) => ({
      options: leaseOptions(data.buyPrice, { depositPct: data.lease.depositPct / 100, tenors: data.lease.tenors }),
    }),

    eaasRules: async (vendorId) => (await assertCompany(vendorId), {
      annualReturn: EAAS_RULES.annualReturn,
      tenorMonths: EAAS_RULES.tenorMonths,
      platformFeePct: EAAS_RULES.platformFeePct,
      depositMonths: EAAS_RULES.depositMonths,
    }),

    listRequests: (vendorId) => requestsModel.listForVendor(vendorId),

    async setRequestStatus(vendorId, id, status) {
      if (!(await requestsModel.setStatusForVendor(id, vendorId, status))) throw notFound('Request');
    },
  };
}
