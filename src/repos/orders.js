import { query, withTransaction } from '../db/pool.js';

const num = (v) => (v == null ? null : Number(v));

const toOrder = (r) => ({
  id: Number(r.id), publicRef: r.public_ref, customerId: Number(r.customer_id), status: r.status,
  shipName: r.ship_name, shipPhone: r.ship_phone, shipAddress: r.ship_address, shipState: r.ship_state, shipArea: r.ship_area,
  subtotal: Number(r.subtotal), serviceCharge: Number(r.service_charge ?? 0), deliveryFee: Number(r.delivery_fee), total: Number(r.total),
  createdAt: r.created_at, paidAt: r.paid_at,
});

const toVo = (r) => ({
  id: Number(r.id), orderId: Number(r.order_id), vendorId: Number(r.vendor_id), status: r.status,
  subtotal: Number(r.subtotal), serviceCharge: Number(r.service_charge ?? 0), commission: Number(r.commission ?? 0), deliveryFee: Number(r.delivery_fee), distanceKm: Number(r.distance_km),
  promisedBy: r.promised_by, accepted_at: r.accepted_at, preparing_at: r.preparing_at, ready_at: r.ready_at,
  picked_up_at: r.picked_up_at, delivered_at: r.delivered_at, completed_at: r.completed_at,
  autoCompleted: Boolean(r.auto_completed), refundNeeded: Boolean(r.refund_needed), createdAt: r.created_at,
});

const toItem = (r) => ({
  id: Number(r.id), voId: Number(r.vendor_order_id), kind: r.kind, refId: Number(r.ref_id), name: r.name,
  imageUrl: r.image_id == null ? null : `/api/images/${r.image_id}`, unitPrice: Number(r.unit_price), qty: Number(r.qty), lineTotal: Number(r.line_total),
});

const toPayment = (r) => ({
  id: Number(r.id), orderId: Number(r.order_id), reference: r.reference, amount: Number(r.amount), currency: r.currency,
  status: r.status, authorizationUrl: r.authorization_url, createdAt: r.created_at, paidAt: r.paid_at,
});

const VO_JOIN = `
  SELECT vo.*, v.company_name AS vendor_name FROM vendor_orders vo
  JOIN vendor_profiles v ON v.user_id = vo.vendor_id`;

async function attach(orderRows) {
  if (!orderRows.length) return [];
  const orders = orderRows.map(toOrder);
  const marks = orders.map(() => '?').join(',');
  const ids = orders.map((o) => o.id);
  const vos = await query(`${VO_JOIN} WHERE vo.order_id IN (${marks}) ORDER BY vo.id`, ids);
  const items = await query(`SELECT * FROM order_items WHERE order_id IN (${marks}) ORDER BY id`, ids);
  const byOrder = new Map(orders.map((o) => [o.id, { ...o, vendorOrders: [] }]));
  const voById = new Map();
  for (const r of vos) {
    const vo = { ...toVo(r), vendorName: r.vendor_name, items: [] };
    voById.set(vo.id, vo);
    byOrder.get(vo.orderId).vendorOrders.push(vo);
  }
  for (const r of items) voById.get(Number(r.vendor_order_id))?.items.push(toItem(r));
  return [...byOrder.values()];
}

export const ordersRepo = {
  // Creates the order and each vendor's part together. If the same customer and key already exist (a double click
  // or a retry), nothing new is created and the existing order is returned.
  async createOrder(d) {
    try {
      const id = await withTransaction(async (conn) => {
        const [res] = await conn.execute(
          `INSERT INTO orders (public_ref, customer_id, ship_name, ship_phone, ship_address, ship_state, ship_area,
                               subtotal, service_charge, delivery_fee, total, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [d.publicRef, d.customerId, d.ship.name, d.ship.phone, d.ship.address, d.ship.state, d.ship.area, d.subtotal, d.serviceCharge, d.deliveryFee, d.total, d.idempotencyKey]
        );
        for (const v of d.vendorOrders) {
          const [vr] = await conn.execute(
            'INSERT INTO vendor_orders (order_id, vendor_id, subtotal, service_charge, commission, delivery_fee, distance_km) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [res.insertId, v.vendorId, v.subtotal, v.serviceCharge, v.commission, v.deliveryFee, v.distanceKm]
          );
          for (const it of v.items) {
            await conn.execute(
              `INSERT INTO order_items (order_id, vendor_order_id, kind, ref_id, name, image_id, unit_price, qty, line_total)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [res.insertId, vr.insertId, it.kind, it.refId, it.name, it.imageId ?? null, it.unitPrice, it.qty, it.lineTotal]
            );
          }
        }
        return res.insertId;
      });
      return { order: await this.getById(id), created: true };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && /uq_orders_idem/.test(err.message)) {
        return { order: await this.findByIdempotency(d.customerId, d.idempotencyKey), created: false };
      }
      throw err;
    }
  },

  async getById(id) {
    const rows = await query('SELECT * FROM orders WHERE id = ? LIMIT 1', [id]);
    return (await attach(rows))[0] ?? null;
  },
  async findByRef(ref) {
    const rows = await query('SELECT * FROM orders WHERE public_ref = ? LIMIT 1', [ref]);
    return (await attach(rows))[0] ?? null;
  },
  async findByIdempotency(customerId, key) {
    const rows = await query('SELECT * FROM orders WHERE customer_id = ? AND idempotency_key = ? LIMIT 1', [customerId, key]);
    return (await attach(rows))[0] ?? null;
  },
  async listForCustomer(customerId) {
    return attach(await query('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 100', [customerId]));
  },

  // ---- payments ----
  // Returns the order's open payment, or starts one. Several requests arriving together (a double click, two tabs)
  // all get the same payment: the order row is locked while we look, so only one of them can create it.
  async openPayment({ orderId, reference, amount }) {
    return withTransaction(async (conn) => {
      await conn.execute('SELECT id FROM orders WHERE id = ? FOR UPDATE', [orderId]);
      const [open] = await conn.execute("SELECT * FROM payments WHERE order_id = ? AND status = 'initiated' ORDER BY id DESC LIMIT 1", [orderId]);
      if (open[0]) return { payment: toPayment(open[0]), created: false };
      const [res] = await conn.execute('INSERT INTO payments (order_id, reference, amount) VALUES (?, ?, ?)', [orderId, reference, amount]);
      const [row] = await conn.execute('SELECT * FROM payments WHERE id = ?', [res.insertId]);
      return { payment: toPayment(row[0]), created: true };
    });
  },
  async findPayment(reference) {
    const rows = await query('SELECT * FROM payments WHERE reference = ? LIMIT 1', [reference]);
    return rows[0] ? toPayment(rows[0]) : null;
  },
  async latestPayment(orderId) {
    const rows = await query('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
    return rows[0] ? toPayment(rows[0]) : null;
  },
  async setPaymentAuth(id, { url, accessCode }) {
    await query('UPDATE payments SET authorization_url = ?, access_code = ? WHERE id = ?', [url, accessCode, id]);
  },
  async failPayment(id) {
    await query("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'initiated'", [id]);
  },

  // The moment a payment counts. Exactly one caller can win this, however many webhooks, retries and page
  // reloads arrive at once: a payment can only be claimed once, and an order only moves from pending_payment to paid once.
  // Returns { won, replay, orderStatus }. `replay` means this very payment was already counted.
  async settlePayment({ orderId, paymentId, paidAt, promised }) {
    return withTransaction(async (conn) => {
      const [claim] = await conn.execute("UPDATE payments SET status = 'success', paid_at = ? WHERE id = ? AND status <> 'success'", [paidAt, paymentId]);
      if (claim.affectedRows === 0) return { won: false, replay: true, orderStatus: null };
      const [won] = await conn.execute("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending_payment'", [paidAt, orderId]);
      if (won.affectedRows === 0) {
        const [rows] = await conn.execute('SELECT status FROM orders WHERE id = ?', [orderId]);
        return { won: false, replay: false, orderStatus: rows[0]?.status ?? null };
      }
      for (const [voId, promisedBy] of promised) {
        await conn.execute("UPDATE vendor_orders SET status = 'placed', promised_by = ? WHERE id = ? AND status = 'awaiting_payment'", [promisedBy, voId]);
      }
      return { won: true, replay: false, orderStatus: 'paid' };
    });
  },

  async recordWebhook(key) {
    const res = await query('INSERT IGNORE INTO webhook_events (event_key) VALUES (?)', [key]);
    return res.affectedRows > 0;
  },

  async addEvent({ orderId, voId = null, actorType, actorId = null, type, note = null }) {
    await query('INSERT INTO order_events (order_id, vendor_order_id, actor_type, actor_id, type, note) VALUES (?, ?, ?, ?, ?, ?)', [orderId, voId, actorType, actorId, type, note]);
  },
  async events(orderId) {
    const rows = await query('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', [orderId]);
    return rows.map((r) => ({ id: Number(r.id), voId: num(r.vendor_order_id), actorType: r.actor_type, type: r.type, note: r.note, at: r.created_at }));
  },

  // One step for one vendor order. Returns false if it is no longer in a state that allows the step.
  async transition(voId, { from, to, stamp, stampIfNull = [], set = {} }, at) {
    const sets = ['status = ?'];
    const params = [to];
    if (stamp) { sets.push(`${stamp} = ?`); params.push(at); }
    for (const c of stampIfNull) { sets.push(`${c} = COALESCE(${c}, ?)`); params.push(at); }
    for (const [c, v] of Object.entries(set)) { sets.push(`${c} = ?`); params.push(v); }
    params.push(voId, ...from);
    const res = await query(`UPDATE vendor_orders SET ${sets.join(', ')} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`, params);
    return res.affectedRows > 0;
  },
  async flagRefund(voId) {
    await query('UPDATE vendor_orders SET refund_needed = 1 WHERE id = ?', [voId]);
  },
  async clearRefund(voId) {
    const res = await query('UPDATE vendor_orders SET refund_needed = 0 WHERE id = ? AND refund_needed = 1', [voId]);
    return res.affectedRows > 0;
  },

  // Everything needed to email about, and act on, one vendor order.
  async getVendorOrderFull(voId) {
    const rows = await query(`${VO_JOIN} WHERE vo.id = ? LIMIT 1`, [voId]);
    if (!rows[0]) return null;
    const vo = { ...toVo(rows[0]), vendorName: rows[0].vendor_name };
    const order = (await attach(await query('SELECT * FROM orders WHERE id = ?', [vo.orderId])))[0];
    vo.items = order.vendorOrders.find((x) => x.id === vo.id)?.items ?? [];
    const [cust] = await query('SELECT id, email, full_name, phone FROM users WHERE id = ?', [order.customerId]);
    const [vend] = await query(
      `SELECT u.id, u.email, u.full_name, u.phone, v.company_name, a.address_line, a.state, a.area_id
       FROM users u JOIN vendor_profiles v ON v.user_id = u.id LEFT JOIN addresses a ON a.user_id = u.id WHERE u.id = ?`,
      [vo.vendorId]
    );
    return {
      vo, order,
      customer: { id: Number(cust.id), email: cust.email, fullName: cust.full_name, phone: cust.phone },
      vendor: {
        id: Number(vend.id), email: vend.email, fullName: vend.full_name, phone: vend.phone, companyName: vend.company_name,
        address: vend.address_line ? { line: vend.address_line, state: vend.state, areaId: vend.area_id } : null,
      },
    };
  },

  async listForVendor(vendorId, { status } = {}) {
    const rows = await query(
      `${VO_JOIN} JOIN orders o ON o.id = vo.order_id
       WHERE vo.vendor_id = ? AND o.status = 'paid' ${status ? 'AND vo.status = ?' : ''} ORDER BY vo.id DESC LIMIT 200`,
      status ? [vendorId, status] : [vendorId]
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => Number(r.id));
    const items = await query(`SELECT * FROM order_items WHERE vendor_order_id IN (${ids.map(() => '?').join(',')})`, ids);
    const orders = await query(`SELECT * FROM orders WHERE id IN (${[...new Set(rows.map((r) => r.order_id))].map(() => '?').join(',')})`, [...new Set(rows.map((r) => r.order_id))]);
    const oById = new Map(orders.map((o) => [Number(o.id), toOrder(o)]));
    const custIds = [...new Set([...oById.values()].map((o) => o.customerId))];
    const custs = await query(`SELECT id, full_name, phone FROM users WHERE id IN (${custIds.map(() => '?').join(',')})`, custIds);
    const cById = new Map(custs.map((c) => [Number(c.id), c]));
    return rows.map((r) => {
      const vo = { ...toVo(r), vendorName: r.vendor_name, items: items.filter((i) => Number(i.vendor_order_id) === Number(r.id)).map(toItem) };
      const o = oById.get(vo.orderId);
      const c = cById.get(o.customerId);
      return { ...vo, order: { publicRef: o.publicRef, shipName: o.shipName, shipPhone: o.shipPhone, shipAddress: o.shipAddress, shipState: o.shipState, shipArea: o.shipArea, paidAt: o.paidAt }, customer: { fullName: c.full_name, phone: c.phone } };
    });
  },

  // For the admin: every paid order, newest first, with optional filters.
  async listAll({ status, state, late, q } = {}) {
    const where = ["o.status = 'paid'"];
    const params = [];
    if (status) { where.push('vo.status = ?'); params.push(status); }
    if (state) { where.push('o.ship_state = ?'); params.push(state); }
    if (late) where.push("vo.promised_by < UTC_TIMESTAMP() AND vo.status NOT IN ('delivered','completed','rejected','cancelled')");
    if (q) { where.push('(o.public_ref LIKE ? OR o.ship_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const rows = await query(
      `${VO_JOIN} JOIN orders o ON o.id = vo.order_id WHERE ${where.join(' AND ')} ORDER BY vo.id DESC LIMIT 300`,
      params
    );
    const out = [];
    for (const r of rows) {
      const full = await this.getVendorOrderFull(Number(r.id));
      out.push(full);
    }
    return out;
  },

  async stats() {
    const [t] = await query(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS gmv FROM orders WHERE status = 'paid'`
    );
    const [s] = await query(
      `SELECT
         SUM(status IN ('placed')) AS awaiting_vendor,
         SUM(status IN ('accepted','preparing','ready_for_pickup')) AS in_prep,
         SUM(status = 'out_for_delivery') AS out_for_delivery,
         SUM(status = 'delivered') AS awaiting_receipt,
         SUM(status = 'completed') AS completed,
         SUM(refund_needed = 1) AS refunds_needed,
         SUM(promised_by < UTC_TIMESTAMP() AND status NOT IN ('delivered','completed','rejected','cancelled')) AS late_now,
         SUM(status IN ('delivered','completed') AND delivered_at <= promised_by) AS on_time,
         SUM(status IN ('delivered','completed') AND delivered_at > promised_by) AS late_delivered,
         COALESCE(SUM(CASE WHEN status NOT IN ('rejected','cancelled') THEN service_charge + commission ELSE 0 END), 0) AS platform_revenue,
         COALESCE(SUM(CASE WHEN status IN ('delivered','completed') THEN service_charge + commission ELSE 0 END), 0) AS platform_revenue_delivered
       FROM vendor_orders WHERE order_id IN (SELECT id FROM orders WHERE status = 'paid')`
    );
    return Object.fromEntries(Object.entries({ orders: t.orders, gmv: t.gmv, ...s }).map(([k, v]) => [k, Number(v ?? 0)]));
  },

  // ---- housekeeping ----
  async dueForAutoReceive(before) {
    const rows = await query("SELECT id FROM vendor_orders WHERE status = 'delivered' AND delivered_at <= ? LIMIT 200", [before]);
    return rows.map((r) => Number(r.id));
  },
  async expirePending(before) {
    const rows = await query("SELECT id FROM orders WHERE status = 'pending_payment' AND created_at <= ? LIMIT 200", [before]);
    for (const r of rows) {
      await query("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'", [r.id]);
      await query("UPDATE vendor_orders SET status = 'cancelled' WHERE order_id = ? AND status = 'awaiting_payment'", [r.id]);
    }
    return rows.map((r) => Number(r.id));
  },
};
