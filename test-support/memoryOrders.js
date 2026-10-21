// An in-memory stand-in for the orders model, with the same all-or-nothing rules for settling a payment and
// moving an order along, so the money-handling logic can be tested without a database.
// `directory` supplies { customer(id), vendor(id) } details.
export function createMemoryOrdersModel(directory, now = () => new Date()) {
  let seq = 0;
  const orders = [];
  const payments = [];
  const events = [];
  const webhooks = new Set();
  const vos = new Map(); // id -> vendor order (live object)
  const clone = (o) => structuredClone(o);

  const withNames = (vo) => ({ ...vo, vendorName: directory.vendor(vo.vendorId).companyName });
  const shape = (o) => ({ ...clone(o), vendorOrders: o.vendorOrders.map((id) => withNames(clone(vos.get(id)))) });

  return {
    _orders: orders, _payments: payments, _events: events, _vos: vos,

    async createOrder(d) {
      const existing = orders.find((o) => o.customerId === d.customerId && o.idempotencyKey === d.idempotencyKey);
      if (existing) return { order: await this.getById(existing.id), created: false };
      const o = {
        id: ++seq, publicRef: d.publicRef, customerId: d.customerId, status: 'pending_payment',
        shipName: d.ship.name, shipPhone: d.ship.phone, shipAddress: d.ship.address, shipState: d.ship.state, shipArea: d.ship.area,
        subtotal: d.subtotal, serviceCharge: d.serviceCharge ?? 0, deliveryFee: d.deliveryFee, total: d.total, idempotencyKey: d.idempotencyKey,
        createdAt: now(), paidAt: null, vendorOrders: [],
      };
      for (const v of d.vendorOrders) {
        const vo = {
          id: ++seq, orderId: o.id, vendorId: v.vendorId, status: 'awaiting_payment', subtotal: v.subtotal, serviceCharge: v.serviceCharge ?? 0, commission: v.commission ?? 0, deliveryFee: v.deliveryFee, distanceKm: v.distanceKm,
          promisedBy: null, accepted_at: null, preparing_at: null, ready_at: null, picked_up_at: null, delivered_at: null, completed_at: null,
          autoCompleted: false, refundNeeded: false,
          items: v.items.map((it) => ({ id: ++seq, kind: it.kind, refId: it.refId, name: it.name, imageUrl: it.imageUrl ?? null, unitPrice: it.unitPrice, qty: it.qty, lineTotal: it.lineTotal })),
        };
        vos.set(vo.id, vo);
        o.vendorOrders.push(vo.id);
      }
      orders.push(o);
      return { order: shape(o), created: true };
    },
    async getById(id) { const o = orders.find((x) => x.id === id); return o ? shape(o) : null; },
    async findByRef(ref) { const o = orders.find((x) => x.publicRef === ref); return o ? this.getById(o.id) : null; },
    async findByIdempotency(c, k) { const o = orders.find((x) => x.customerId === c && x.idempotencyKey === k); return o ? this.getById(o.id) : null; },
    async listForCustomer(c) { return Promise.all(orders.filter((o) => o.customerId === c).reverse().map((o) => this.getById(o.id))); },

    async openPayment({ orderId, reference, amount }) {
      const open = payments.filter((p) => p.orderId === orderId && p.status === 'initiated').at(-1);
      if (open) return { payment: { ...open }, created: false };
      if (payments.some((p) => p.reference === reference)) throw new Error('duplicate reference');
      const p = { id: ++seq, orderId, reference, amount, currency: 'NGN', status: 'initiated', authorizationUrl: null, createdAt: new Date(), paidAt: null };
      payments.push(p);
      return { payment: { ...p }, created: true };
    },
    async findPayment(ref) { const p = payments.find((x) => x.reference === ref); return p ? { ...p } : null; },
    async latestPayment(orderId) { const l = payments.filter((p) => p.orderId === orderId).at(-1); return l ? { ...l } : null; },
    async setPaymentAuth(id, { url }) { payments.find((p) => p.id === id).authorizationUrl = url; },
    async failPayment(id) { const p = payments.find((x) => x.id === id); if (p.status === 'initiated') p.status = 'failed'; },

    // No awaits inside: like the database transaction, nothing else can slip in between the check and the change.
    async settlePayment({ orderId, paymentId, paidAt, promised }) {
      const p = payments.find((x) => x.id === paymentId);
      if (p.status === 'success') return { won: false, replay: true, orderStatus: null };
      p.status = 'success'; p.paidAt = paidAt;
      const o = orders.find((x) => x.id === orderId);
      if (o.status !== 'pending_payment') return { won: false, replay: false, orderStatus: o.status };
      o.status = 'paid'; o.paidAt = paidAt;
      for (const [voId, by] of promised) { const vo = vos.get(voId); if (vo.status === 'awaiting_payment') { vo.status = 'placed'; vo.promisedBy = by; } }
      return { won: true, replay: false, orderStatus: 'paid' };
    },
    async recordWebhook(key) { if (webhooks.has(key)) return false; webhooks.add(key); return true; },
    async addEvent(e) { events.push({ id: ++seq, voId: null, actorId: null, note: null, ...e, at: new Date() }); },
    async events(orderId) { return events.filter((e) => e.orderId === orderId).map((e) => ({ ...e })); },

    async transition(voId, { from, to, stamp, stampIfNull = [], set = {} }, at) {
      const vo = vos.get(voId);
      if (!vo || !from.includes(vo.status)) return false;
      vo.status = to;
      if (stamp) vo[stamp] = at;
      for (const c of stampIfNull) vo[c] ??= at;
      for (const [c, v] of Object.entries(set)) vo[c === 'auto_completed' ? 'autoCompleted' : c] = Boolean(v);
      return true;
    },
    async flagRefund(voId) { vos.get(voId).refundNeeded = true; },
    async clearRefund(voId) { const vo = vos.get(voId); if (!vo?.refundNeeded) return false; vo.refundNeeded = false; return true; },

    async getVendorOrderFull(voId) {
      const vo = vos.get(voId);
      if (!vo) return null;
      const order = await this.getById(vo.orderId);
      return { vo: withNames(clone(vo)), order, customer: directory.customer(order.customerId), vendor: directory.vendor(vo.vendorId) };
    },
    async listForVendor(vendorId, { status } = {}) {
      const out = [];
      for (const vo of [...vos.values()].reverse()) {
        const o = orders.find((x) => x.id === vo.orderId);
        if (vo.vendorId !== vendorId || o.status !== 'paid' || (status && vo.status !== status)) continue;
        out.push({ ...withNames(clone(vo)), order: clone(o), customer: { fullName: directory.customer(o.customerId).fullName } });
      }
      return out;
    },
    async listAll({ status } = {}) {
      const out = [];
      for (const vo of [...vos.values()].reverse()) {
        const o = orders.find((x) => x.id === vo.orderId);
        if (o.status !== 'paid' || (status && vo.status !== status)) continue;
        out.push(await this.getVendorOrderFull(vo.id));
      }
      return out;
    },
    async stats() {
      const paid = orders.filter((o) => o.status === 'paid');
      return { orders: paid.length, gmv: paid.reduce((s, o) => s + o.total, 0), platform_revenue: [...vos.values()].filter((v) => !['rejected', 'cancelled'].includes(v.status) && orders.find((o) => o.id === v.orderId).status === 'paid').reduce((a, v) => a + v.serviceCharge + v.commission, 0) };
    },
    async dueForAutoReceive(before) {
      return [...vos.values()].filter((v) => v.status === 'delivered' && v.delivered_at <= before).map((v) => v.id);
    },
    async expirePending(before) {
      const out = [];
      for (const o of orders) {
        if (o.status === 'pending_payment' && o.createdAt <= before) {
          o.status = 'cancelled';
          for (const id of o.vendorOrders) { const vo = vos.get(id); if (vo.status === 'awaiting_payment') vo.status = 'cancelled'; }
          out.push(o.id);
        }
      }
      return out;
    },
  };
}
