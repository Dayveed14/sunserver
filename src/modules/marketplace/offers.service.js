import { eaasOffered } from '../../config/launch.js';
import { HttpError } from '../../lib/httpError.js';
import {
  PLANS,
  dealFit,
  dealSpecs,
  diyOptions,
  limits,
  matchDeals,
  planOffer,
  quoteDiy,
  requirementFromResult,
} from './matching.js';

const bad = (code, message, details) => new HttpError(400, code, message, details);

// A vendor is visible to customers unless rejected (or unless approval is required and they are not verified yet).
const vendorVisible = (requireVerified) => (x) =>
  requireVerified ? x.vendorVerification === 'verified' : x.vendorVerification !== 'rejected';

// What a customer is allowed to see about a product or deal. No internal fields.
export const publicProduct = (p) => ({
  id: p.id,
  category: p.category,
  name: p.name,
  brand: p.brand,
  rating: p.rating,
  systemVoltage: p.systemVoltage,
  batteryType: p.batteryType,
  price: p.price,
  inStock: p.inStock,
  warrantyYears: p.warrantyYears,
  description: p.description,
  imageUrl: p.imageUrl ?? null,
  vendor: { id: p.vendorId, name: p.vendorName, verified: p.vendorVerified, state: p.vendorState ?? null },
});

export const publicDeal = (deal) => ({
  id: deal.id,
  title: deal.title,
  description: deal.description,
  imageUrl: deal.imageUrl ?? null,
  vendor: { id: deal.vendorId, name: deal.vendorName, verified: deal.vendorVerified, state: deal.vendorState ?? null },
  installationIncluded: deal.installationIncluded,
  warrantyYears: deal.warrantyYears,
  items: deal.items.map((i) => ({
    productId: i.productId, name: i.name, brand: i.brand, category: i.category,
    rating: i.rating, systemVoltage: i.systemVoltage, qty: i.qty,
  })),
});

export function createOffersService({ productsRepo, dealsRepo, requestsRepo, assessmentsRepo, config }) {
  const visible = vendorVisible(config.requireVerified);
  const verifiedOpt = { requireVerified: config.requireVerified };

  async function loadAssessment(userId, assessmentId) {
    const row = await assessmentsRepo.findForUser(assessmentId, userId);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Assessment not found.');
    const result = row.result_json;
    return {
      row,
      result,
      requirement: requirementFromResult(result),
      baseline: {
        monthlyCost: result.current.monthlyCost,
        monthlyMaintenance: result.solar.monthlyMaintenance,
        segment: result.segment,
        kwhPerMonth: result.usage.kwhPerMonth,
      },
    };
  }

  async function quoteDiyFor(userId, assessmentId, items) {
    const { requirement } = await loadAssessment(userId, assessmentId);
    const found = await productsRepo.findManyByIds(items.map((i) => i.productId));
    const byId = new Map(found.filter(visible).map((p) => [p.id, p]));
    const quote = quoteDiy(requirement, items, byId);

    const vendors = new Map();
    for (const line of quote.lines) {
      const v = vendors.get(line.vendorId) ?? { vendorId: line.vendorId, vendorName: line.vendorName, subtotal: 0 };
      v.subtotal += line.lineTotal;
      vendors.set(line.vendorId, v);
    }
    return { ...quote, vendors: [...vendors.values()] };
  }

  return {
    async getOffers(userId, assessmentId, plan, role) {
      if (!PLANS.includes(plan)) throw bad('VALIDATION_ERROR', 'Choose buy, lease, rent or energy as a service.');
      if (plan === 'eaas' && !eaasOffered(role)) throw bad('NOT_AVAILABLE', 'Energy as a service is offered to business accounts only.');
      const { result, requirement, baseline } = await loadAssessment(userId, assessmentId);
      const deals = (await dealsRepo.listActive(verifiedOpt)).filter(visible);

      const counts = {};
      for (const p of PLANS) if (p !== 'eaas' || eaasOffered(role)) counts[p] = matchDeals(requirement, deals, p, baseline).length;
      const matches = matchDeals(requirement, deals, plan, baseline);

      const out = {
        plan,
        requirement,
        limits: limits(requirement),
        estimate: result.options[plan], // our own indicative figure from the assessment, for comparison
        currentMonthlyCost: baseline.monthlyCost,
        dealCounts: counts,
        deals: matches.map((m) => ({ ...publicDeal(m.deal), specs: m.specs, fit: m.fit, offer: m.offer })),
      };

      // Parts-by-parts is only meaningful when buying outright.
      if (plan === 'buy') {
        const products = (await productsRepo.listBuyable(verifiedOpt)).filter(visible);
        const opts = diyOptions(requirement, products);
        out.diy = {
          panels: opts.panels.map((o) => ({ ...publicProduct(o.product), qty: o.qty })),
          inverters: opts.inverters.map((o) => ({ ...publicProduct(o.product), qty: o.qty })),
          batteries: opts.batteries.map((o) => ({ ...publicProduct(o.product), qtyByVoltage: o.qtyByVoltage })),
        };
      }
      return out;
    },

    quoteDiy: quoteDiyFor,

    async createRequests(userId, assessmentId, body, role) {
      if (body.plan === 'eaas' && !eaasOffered(role)) throw bad('NOT_AVAILABLE', 'Energy as a service is offered to business accounts only.');
      const { result, requirement, baseline } = await loadAssessment(userId, assessmentId);
      const needs = {
        segment: result.segment,
        discoName: result.disco.name,
        kwhPerDay: result.usage.kwhPerDay,
        connectedKw: result.usage.connectedKw,
        supplyBand: result.supplyBand,
        requirement,
      };

      if (body.kind === 'deal') {
        const deal = await dealsRepo.findActive(body.dealId, verifiedOpt);
        if (!deal || !visible(deal)) throw new HttpError(404, 'NOT_FOUND', 'That deal is no longer available.');
        const specs = dealSpecs(deal.items);
        const offer = planOffer(deal, body.plan, baseline, { months: body.months });
        if (body.plan === 'lease' && body.months && offer && offer.termMonths !== body.months) {
          throw bad('VALIDATION_ERROR', 'That payment plan is not offered on this deal.');
        }
        if (!dealFit(requirement, specs) || !offer) {
          throw bad('NOT_A_MATCH', 'That deal does not fit this assessment or plan any more.');
        }
        const dup = await requestsRepo.findOpenDuplicate({
          customerId: userId, vendorId: deal.vendorId, assessmentId, kind: 'deal', dealId: deal.id, plan: body.plan,
        });
        if (dup) throw new HttpError(409, 'ALREADY_REQUESTED', 'You already asked this vendor about this deal.');

        const id = await requestsRepo.create({
          customerId: userId,
          vendorId: deal.vendorId,
          assessmentId,
          kind: 'deal',
          dealId: deal.id,
          plan: body.plan,
          upfrontPrice: offer.upfront,
          monthlyPrice: offer.monthly,
          message: body.message,
          summary: { needs, deal: { ...publicDeal(deal), specs }, offer },
        });
        return { requests: [{ id, vendorName: deal.vendorName, status: 'new' }] };
      }

      // DIY: price it again on the server, then send each vendor only their own parts.
      const quote = await quoteDiyFor(userId, assessmentId, body.items);
      if (!quote.valid) throw bad('INVALID_SELECTION', quote.errors[0].message, { errors: quote.errors });

      for (const v of quote.vendors) {
        const dup = await requestsRepo.findOpenDuplicate({
          customerId: userId, vendorId: v.vendorId, assessmentId, kind: 'diy', dealId: null, plan: 'buy',
        });
        if (dup) throw new HttpError(409, 'ALREADY_REQUESTED', `You already sent ${v.vendorName} a request for this system.`);
      }

      const created = [];
      for (const v of quote.vendors) {
        const lines = quote.lines.filter((l) => l.vendorId === v.vendorId);
        const id = await requestsRepo.create({
          customerId: userId,
          vendorId: v.vendorId,
          assessmentId,
          kind: 'diy',
          dealId: null,
          plan: 'buy',
          upfrontPrice: v.subtotal,
          monthlyPrice: null,
          message: body.message,
          summary: {
            needs,
            lines,
            subtotal: v.subtotal,
            wholeSystem: { totals: quote.totals, subtotal: quote.subtotal, otherVendors: quote.vendors.filter((o) => o.vendorId !== v.vendorId).map((o) => o.vendorName) },
          },
        });
        created.push({ id, vendorName: v.vendorName, status: 'new' });
      }
      return { requests: created };
    },

    listMine: (userId) => requestsRepo.listForCustomer(userId),

    async cancel(userId, id) {
      if (!(await requestsRepo.cancelForCustomer(id, userId))) {
        throw new HttpError(404, 'NOT_FOUND', 'Request not found, or it can no longer be cancelled.');
      }
    },
  };
}
