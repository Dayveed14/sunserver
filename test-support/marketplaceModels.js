// In-memory stand-ins for the marketplace models, shaped like the real ones.
export function createMarketplaceModels() {
  let seq = 100;
  const products = [];
  const deals = [];
  const requests = [];
  const assessments = new Map();
  const vendors = new Map(); // id -> { name, verification }

  const vendorInfo = (id) => vendors.get(id) ?? { name: `Vendor ${id}`, verification: 'pending' };
  const decorate = (p) => ({
    ...p,
    vendorName: vendorInfo(p.vendorId).name,
    vendorVerification: vendorInfo(p.vendorId).verification,
    vendorVerified: vendorInfo(p.vendorId).verification === 'verified',
  });
  const dealView = (d) => ({
    ...d,
    vendorName: vendorInfo(d.vendorId).name,
    vendorVerification: vendorInfo(d.vendorId).verification,
    vendorVerified: vendorInfo(d.vendorId).verification === 'verified',
    items: d.items.map((i) => {
      const p = products.find((x) => x.id === i.productId);
      return { ...i, name: p.name, brand: p.brand, category: p.category, rating: p.rating, systemVoltage: p.systemVoltage, price: p.price, productStatus: p.status };
    }),
  });

  const productsModel = {
    async listByVendor(vendorId) { return products.filter((p) => p.vendorId === vendorId && p.status !== 'archived').map(decorate); },
    async findOwned(id, vendorId) { const p = products.find((x) => x.id === id && x.vendorId === vendorId && x.status !== 'archived'); return p ? decorate(p) : null; },
    async findManyByIds(ids) { return products.filter((p) => ids.includes(p.id)).map(decorate); },
    async create(vendorId, d) { const p = { id: ++seq, vendorId, brand: null, batteryType: null, warrantyYears: null, description: null, ...d }; products.push(p); return p.id; },
    async update(id, vendorId, d) { const p = products.find((x) => x.id === id && x.vendorId === vendorId); Object.assign(p, d); return true; },
    async archive(id, vendorId) { const p = products.find((x) => x.id === id && x.vendorId === vendorId); if (!p) return false; p.status = 'archived'; return true; },
    async countByVendor(vendorId) { return products.filter((p) => p.vendorId === vendorId && p.status !== 'archived').length; },
    async listBuyable() { return products.filter((p) => p.status === 'active' && p.inStock && ['panel', 'inverter', 'battery'].includes(p.category)).map(decorate); },
  };

  const dealsModel = {
    async listByVendor(vendorId) { return deals.filter((d) => d.vendorId === vendorId && d.status !== 'archived').map(dealView); },
    async findOwned(id, vendorId) { const d = deals.find((x) => x.id === id && x.vendorId === vendorId && x.status !== 'archived'); return d ? dealView(d) : null; },
    async findActive(id) { const d = deals.find((x) => x.id === id && x.status === 'active'); return d ? dealView(d) : null; },
    async listActive() { return deals.filter((d) => d.status === 'active').map(dealView); },
    async create(vendorId, d) {
      const deal = { id: ++seq, vendorId, ...d, items: d.items.map((i) => ({ productId: i.productId, qty: i.qty })) };
      deals.push(deal);
      return deal.id;
    },
    async update(id, vendorId, d) { const deal = deals.find((x) => x.id === id && x.vendorId === vendorId); Object.assign(deal, d, { items: d.items.map((i) => ({ productId: i.productId, qty: i.qty })) }); return true; },
    async setStatus(id, vendorId, status) { const d = deals.find((x) => x.id === id && x.vendorId === vendorId); d.status = status; return true; },
    async countActiveByVendor(vendorId) { return deals.filter((d) => d.vendorId === vendorId && d.status === 'active').length; },
  };

  const requestsModel = {
    async create(r) { const row = { id: ++seq, status: 'new', ...r }; requests.push(row); return row.id; },
    async findOpenDuplicate(q) {
      const f = requests.find((r) => r.customerId === q.customerId && r.vendorId === q.vendorId && r.kind === q.kind && r.plan === q.plan
        && (r.assessmentId ?? null) === (q.assessmentId ?? null) && (r.dealId ?? null) === (q.dealId ?? null) && ['new', 'contacted'].includes(r.status));
      return f?.id ?? null;
    },
    async listForVendor(vendorId) { return requests.filter((r) => r.vendorId === vendorId); },
    async listForCustomer(customerId) { return requests.filter((r) => r.customerId === customerId); },
    async setStatusForVendor(id, vendorId, status) { const r = requests.find((x) => x.id === id && x.vendorId === vendorId); if (!r) return false; r.status = status; return true; },
    async cancelForCustomer(id, customerId) { const r = requests.find((x) => x.id === id && x.customerId === customerId && ['new', 'contacted'].includes(x.status)); if (!r) return false; r.status = 'cancelled'; return true; },
    async countNewForVendor(vendorId) { return requests.filter((r) => r.vendorId === vendorId && r.status === 'new').length; },
  };

  const assessmentsModel = {
    async findForUser(id, userId) { const a = assessments.get(Number(id)); return a && a.userId === userId ? { id, result_json: a.result } : null; },
  };
  const vendorsModel = { async getProfile(id) { const v = vendorInfo(id); return { userId: id, companyName: v.name, verification: v.verification }; } };

  return {
    productsModel, dealsModel, requestsModel, assessmentsModel, vendorsModel, requests, products, deals,
    addAssessment(id, userId, result) { assessments.set(id, { userId, result }); },
    setVendor(id, name, verification = 'pending') { vendors.set(id, { name, verification }); },
  };
}
