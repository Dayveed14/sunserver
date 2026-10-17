import { HttpError } from '../../lib/httpError.js';
import { EAAS_RULES, computeEaas, componentsFromItems } from './eaas.js';
import { checkDealComposition, dealSpecs, plansOffered } from './matching.js';

// Vendor-side rules: what a vendor may list and how a deal must be put together.
// Repos are injected so the rules can be tested without a database.
export function createCatalogService({ productsRepo, dealsRepo, requestsRepo, vendorsRepo }) {
  const notFound = (what) => new HttpError(404, 'NOT_FOUND', `${what} not found.`);

  // Turns the vendor's picks into full items, making sure every product is theirs and still listed.
  async function resolveItems(vendorId, items) {
    const owned = await productsRepo.listByVendor(vendorId);
    const byId = new Map(owned.map((p) => [p.id, p]));
    const resolved = [];
    for (const { productId, qty } of items) {
      const p = byId.get(productId);
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

  const withSpecs = (deal) => ({ ...deal, specs: dealSpecs(deal.items), plans: plansOffered(deal) });

  return {
    async summary(vendorId) {
      const [profile, products, activeDeals, newRequests] = await Promise.all([
        vendorsRepo.getProfile(vendorId),
        productsRepo.countByVendor(vendorId),
        dealsRepo.countActiveByVendor(vendorId),
        requestsRepo.countNewForVendor(vendorId),
      ]);
      return { verification: profile?.verification ?? 'pending', products, activeDeals, newRequests };
    },

    listProducts: (vendorId) => productsRepo.listByVendor(vendorId),

    async createProduct(vendorId, data) {
      const id = await productsRepo.create(vendorId, data);
      return productsRepo.findOwned(id, vendorId);
    },

    async updateProduct(vendorId, id, data) {
      const existing = await productsRepo.findOwned(id, vendorId);
      if (!existing) throw notFound('Product');
      // Changing a product's type would silently change every deal that uses it.
      if (existing.category !== data.category) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'A product\'s type cannot be changed. Add a new product instead.', {
          fields: { category: 'Type cannot be changed.' },
        });
      }
      await productsRepo.update(id, vendorId, data);
      return productsRepo.findOwned(id, vendorId);
    },

    async archiveProduct(vendorId, id) {
      if (!(await productsRepo.archive(id, vendorId))) throw notFound('Product');
    },

    async listDeals(vendorId) {
      return (await dealsRepo.listByVendor(vendorId)).map(withSpecs);
    },

    async createDeal(vendorId, data) {
      const items = await resolveItems(vendorId, data.items);
      const id = await dealsRepo.create(vendorId, { ...data, items });
      return withSpecs(await dealsRepo.findOwned(id, vendorId));
    },

    async updateDeal(vendorId, id, data) {
      if (!(await dealsRepo.findOwned(id, vendorId))) throw notFound('Deal');
      const items = await resolveItems(vendorId, data.items);
      await dealsRepo.update(id, vendorId, { ...data, items });
      return withSpecs(await dealsRepo.findOwned(id, vendorId));
    },

    async setDealStatus(vendorId, id, status) {
      const deal = await dealsRepo.findOwned(id, vendorId);
      if (!deal) throw notFound('Deal');
      if (status === 'active') {
        if (deal.items.some((i) => i.productStatus === 'archived')) {
          throw new HttpError(400, 'INVALID_DEAL', 'This deal uses a product you removed. Edit the deal first.');
        }
        if (plansOffered(deal).length === 0) {
          throw new HttpError(400, 'INVALID_DEAL', 'Set a price for at least one way to pay before publishing.');
        }
      }
      await dealsRepo.setStatus(id, vendorId, status);
      return withSpecs(await dealsRepo.findOwned(id, vendorId));
    },

    async archiveDeal(vendorId, id) {
      if (!(await dealsRepo.findOwned(id, vendorId))) throw notFound('Deal');
      // 'archived' keeps old requests that point at it intact.
      await dealsRepo.setStatus(id, vendorId, 'archived');
    },

    // Shows a vendor what their EaaS terms would charge a home and a business, before they publish.
    async previewEaas(vendorId, { items, eaas }) {
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

    eaasRules: () => ({
      annualReturn: EAAS_RULES.annualReturn,
      tenorMonths: EAAS_RULES.tenorMonths,
      platformFeePct: EAAS_RULES.platformFeePct,
      depositMonths: EAAS_RULES.depositMonths,
    }),

    listRequests: (vendorId) => requestsRepo.listForVendor(vendorId),

    async setRequestStatus(vendorId, id, status) {
      if (!(await requestsRepo.setStatusForVendor(id, vendorId, status))) throw notFound('Request');
    },
  };
}
