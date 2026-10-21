// End-to-end check against a REAL database: sign-up, selling, buying, paying, the whole order life cycle.
// Run it after `npm run db:init`:   npm run e2e      (uses the DB_* settings in your .env; simulation mode for Paystack)
// It creates a few throw-away test accounts (e2e-*@example.test) and orders. Use a development database.
process.env.JWT_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-1234';
process.env.PAYSTACK_SECRET_KEY = '';
process.env.NODE_ENV = 'development';
process.env.LOGISTICS_EMAIL = 'rider@example.test';
process.env.ADMIN_NOTIFY_EMAIL = 'admin@example.test';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';

const mails = [];
const realLog = console.log;
console.log = (...a) => { const s = a.join(' '); mails.push(s); if (!s.startsWith('[mail:dev]')) realLog(...a); };

const { createApp } = await import('../src/app.js');
const { createDispatchTokens } = await import('../src/lib/dispatchToken.js');
const { createWebhookHandler } = await import('../src/controllers/webhook.controller.js');
const { ordersService } = await import('../src/services/index.js');
const { query, pool } = await import('../src/db/pool.js');

const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/api`;

function client() {
  let cookie = '';
  return async (method, path, body, headers = {}, raw) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(raw ? { 'Content-Type': raw.type } : body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: raw ? raw.data : body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) cookie = c.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json };
  };
}
const step = (m) => realLog(`✓ ${m}`);
const lastCode = (email) => {
  const hit = [...mails].reverse().find((m) => m.includes(`Verification code for ${email}`));
  return hit.match(/: (\d{6})$/)[1];
};

async function signUp(role, name, email, extra = {}) {
  const api = client();
  const reg = await api('POST', '/auth/register', {
    role, fullName: name, email, phone: '08031234567', password: 'Passw0rd!long',
    address: { line: '12 Test Street', state: 'lagos', areaId: extra.areaId ?? 'ikeja' }, ...(role !== 'individual' ? { companyName: `${name} Ltd` } : {}),
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const ver = await api('POST', '/auth/verify-otp', { email, role, code: lastCode(email) });
  assert.ok(ver.status === 200, JSON.stringify(ver.body));
  return api;
}

const stamp = Date.now();
const vEmail = `e2e-vendor-${stamp}@example.test`;
const cEmail = `e2e-buyer-${stamp}@example.test`;

const vendor = await signUp('vendor', 'Bright Solar', vEmail);
step('vendor signed up with phone and address');
const buyer = await signUp('individual', 'Chi Buyer', cEmail, { areaId: 'yaba' });
step('customer signed up');

// one email, a second kind of account
const dup = await client()('POST', '/auth/register', { role: 'vendor', fullName: 'X', email: vEmail, phone: '08031234567', password: 'Passw0rd!long', companyName: 'Y Ltd', address: { line: '1 Another Road', state: 'lagos', areaId: 'ikeja' } });
assert.ok(dup.status >= 400 && dup.status < 500);
step('same email + same role is refused');
const added = await buyer('POST', '/auth/accounts', { role: 'vendor', companyName: 'Chi Sells', password: 'Passw0rd!long', address: { line: '9 Market Road, Yaba', state: 'lagos', areaId: 'yaba' } });
assert.ok(added.status === 200 || added.status === 201, JSON.stringify(added.body));
const me = await buyer('GET', '/auth/me');
assert.ok(me.body.accounts.length >= 2);
step('an individual opened a vendor account on the same email');
const back = await buyer('POST', '/auth/switch', { role: 'individual' });
assert.equal(back.status, 200);

// vendor lists a product with a picture
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const img = await vendor('POST', '/vendor/images', null, {}, { type: 'image/png', data: png });
assert.equal(img.status, 201, JSON.stringify(img.body));
const prod = await vendor('POST', '/vendor/products', { category: 'panel', name: 'Mono 550W', brand: 'Acme', rating: 550, price: 100000, inStock: true, status: 'active', imageId: img.body.id });
assert.equal(prod.status, 201, JSON.stringify(prod.body));
const pid = prod.body.product.id;
step('vendor added a product with a picture');

// the vendor edits their own product: price and details
const edited = await vendor('PUT', `/vendor/products/${pid}`, { category: 'panel', name: 'Mono 550W', brand: 'Acme', rating: 550, price: 98000, inStock: true, status: 'active', imageId: img.body.id, description: 'Tier 1 cells' });
assert.equal(edited.status, 200, JSON.stringify(edited.body));
assert.equal(edited.body.product.price, 98000);
step('vendor edited their product (price and details)');

// the admin edits any vendor's product and it is recorded
const bcrypt = (await import('bcryptjs')).default;
const aEmail = `e2e-admin-${stamp}@example.test`;
await query(`INSERT INTO users (email, password_hash, role, full_name, email_verified_at) VALUES (?, ?, 'admin', 'E2E Admin', UTC_TIMESTAMP())`, [aEmail, await bcrypt.hash('Passw0rd!long', 4)]);
const admin = client();
assert.equal((await admin('POST', '/auth/login', { email: aEmail, password: 'Passw0rd!long' })).status, 200);
const listed = await admin('GET', '/admin/products?q=Mono');
assert.ok(listed.body.products.some((p) => p.id === pid && p.vendorName));
const fixed = await admin('PUT', `/admin/products/${pid}`, { category: 'panel', name: 'Mono 550W', brand: 'Acme', rating: 550, price: 97000, inStock: true, status: 'active', imageId: img.body.id });
assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
assert.equal(fixed.body.product.price, 97000);
assert.equal((await vendor('PUT', `/admin/products/${pid}`, { category: 'panel', name: 'x', rating: 550, price: 1, inStock: true, status: 'active' })).status, 403);
const audit = await admin('GET', '/admin/audit');
assert.ok(audit.body.entries.some((e) => e.action === 'product.update' && e.target === `product:${pid}`));
await vendor('PUT', `/vendor/products/${pid}`, { category: 'panel', name: 'Mono 550W', brand: 'Acme', rating: 550, price: 100000, inStock: true, status: 'active', imageId: img.body.id });
step('admin listed and edited a vendor product; a vendor cannot use the admin route; the change is in the audit log');
const pic = await fetch(base + img.body.url.replace('/api', ''));
assert.equal(pic.status, 200);

// shop: state filter, product page, delivery
const lagos = await client()('GET', '/shop/products?state=lagos');
assert.ok(lagos.body.products.some((p) => p.id === pid && p.imageUrl));
const abuja = await client()('GET', '/shop/products?state=abuja');
assert.ok(!abuja.body.products.some((p) => p.id === pid));
const page = await client()('GET', `/shop/products/${pid}?state=lagos&areaId=yaba`);
assert.equal(page.body.delivery.available, true);
const cross = await client()('GET', `/shop/products/${pid}?state=abuja&areaId=garki`);
assert.equal(cross.body.delivery.available, false);
step(`shop is state-limited; product page says vendor is ${page.body.delivery.distanceKm} km away, delivery ₦${page.body.delivery.fee}`);

// checkout with idempotency
const items = [{ kind: 'product', id: pid, qty: 2 }];
const q = await buyer('POST', '/checkout/quote', { items });
assert.equal(q.status, 200, JSON.stringify(q.body));
assert.equal(q.body.quote.subtotal, 200000);
assert.equal(q.body.quote.serviceCharge, 20000); // 10% service charge added for the customer
assert.equal(q.body.quote.total, 200000 + 20000 + q.body.quote.deliveryFee);
const key = crypto.randomBytes(12).toString('hex');
const [c1, c2, c3] = await Promise.all([1, 2, 3].map(() => buyer('POST', '/checkout', { items }, { 'Idempotency-Key': key })));
for (const c of [c1, c2, c3]) assert.ok(c.status === 201 || c.status === 200, JSON.stringify(c.body));
assert.equal(new Set([c1, c2, c3].map((c) => c.body.order.ref)).size, 1);
const ref = c1.body.order.ref;
const [orderRows] = [await query('SELECT COUNT(*) AS n FROM orders WHERE public_ref = ?', [ref])];
assert.equal(Number(orderRows[0].n), 1);
const payRows = await query('SELECT COUNT(*) AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_ref = ?', [ref]);
assert.equal(Number(payRows[0].n), 1);
step('three simultaneous checkouts with one key made one order and one payment');

// unpaid orders are invisible to the vendor
assert.equal((await vendor('GET', '/vendor/orders')).body.orders.filter((o) => o.ref === ref).length, 0);

// payment: simulation page, many verifications at once
const reference = c1.body.payment.reference;
const results = await Promise.all(Array.from({ length: 8 }, () => buyer('POST', '/checkout/mock-pay', { reference })));
assert.ok(results.every((r) => r.status === 200 && r.body.status === 'paid'), JSON.stringify(results.map((r) => r.body)));
const confirmed = await query("SELECT COUNT(*) AS n FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.public_ref = ? AND e.type = 'payment_confirmed'", [ref]);
assert.equal(Number(confirmed[0].n), 1);
assert.equal(mails.filter((m) => m.includes(`Payment confirmed · ${ref}`)).length, 1);
step('8 simultaneous payment confirmations counted exactly once; one "payment confirmed" email');

// life cycle
const vo = (await vendor('GET', '/vendor/orders')).body.orders.find((o) => o.ref === ref);
assert.ok(vo && vo.status === 'placed' && vo.promisedBy);
assert.equal(vo.earnings, 180000); // 200,000 minus the 10% platform fee
assert.equal(vo.commission, 20000);
const bad = await vendor('POST', `/vendor/orders/${vo.id}/ready`, {});
assert.equal(bad.status, 409);
for (const a of ['accept', 'prepare', 'ready']) assert.equal((await vendor('POST', `/vendor/orders/${vo.id}/${a}`, {})).status, 200);
assert.ok(mails.some((m) => m.includes('rider@example.test') && m.includes('Please send a rider')));
const tokens = createDispatchTokens(`${process.env.JWT_SECRET}:dispatch`);
const rider = client();
const tPick = tokens.sign(vo.id, 'pickup');
assert.equal((await rider('GET', `/dispatch/info?t=${encodeURIComponent(tPick)}`)).status, 200);
assert.equal((await rider('GET', `/dispatch/info?t=${encodeURIComponent(`${tPick}x`)}`)).status, 404);
assert.equal((await rider('POST', '/dispatch/confirm', { t: tPick })).status, 200);
assert.equal((await rider('POST', '/dispatch/confirm', { t: tokens.sign(vo.id, 'deliver') })).status, 200);
const mine = (await buyer('GET', `/orders/${ref}`)).body.order;
assert.equal(mine.vendorOrders[0].status, 'delivered');
assert.equal(mine.vendorOrders[0].canConfirmReceived, true);
assert.equal((await buyer('POST', `/orders/${ref}/received/${vo.id}`)).status, 200);
assert.equal((await buyer('GET', `/orders/${ref}`)).body.order.vendorOrders[0].status, 'completed');
step('accept → prepare → ready → picked up → delivered → received, with rider emails');

// auto-receive after 12h
const key2 = crypto.randomBytes(12).toString('hex');
const c = await buyer('POST', '/checkout', { items: [{ kind: 'product', id: pid, qty: 1 }] }, { 'Idempotency-Key': key2 });
await buyer('POST', '/checkout/mock-pay', { reference: c.body.payment.reference });
const vo2 = (await vendor('GET', '/vendor/orders?status=placed')).body.orders[0];
await vendor('POST', `/vendor/orders/${vo2.id}/accept`, {});
await rider('POST', '/dispatch/confirm', { t: tokens.sign(vo2.id, 'pickup') });
await rider('POST', '/dispatch/confirm', { t: tokens.sign(vo2.id, 'deliver') });
await query("UPDATE vendor_orders SET delivered_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 13 HOUR) WHERE id = ?", [vo2.id]);
const job = await ordersService.housekeeping();
assert.ok(job.autoReceived >= 1);
const [row] = await query('SELECT status, auto_completed FROM vendor_orders WHERE id = ?', [vo2.id]);
assert.equal(row.status, 'completed');
assert.equal(Number(row.auto_completed), 1);
step('a delivered order nobody confirmed was marked received after 12 hours');

// real webhook signature check against the real database
const secret = 'sk_test_e2e';
const c4 = await buyer('POST', '/checkout', { items: [{ kind: 'product', id: pid, qty: 1 }] }, { 'Idempotency-Key': crypto.randomBytes(12).toString('hex') });
const hookApp = express();
hookApp.post('/hook', express.raw({ type: '*/*' }), createWebhookHandler({ service: ordersService, secretKey: secret }));
const hook = http.createServer(hookApp);
await new Promise((r) => hook.listen(0, r));
const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
const total = c4.body.order.total;
const payload = JSON.stringify({ event: 'charge.success', data: { reference: c4.body.payment.reference, status: 'success', amount: total * 100, currency: 'NGN' } });
const sig = crypto.createHmac('sha512', secret).update(payload).digest('hex');
assert.equal((await fetch(hookUrl, { method: 'POST', body: payload, headers: { 'x-paystack-signature': 'nope' } })).status, 401);
const short = payload.replace(`"amount":${total * 100}`, '"amount":100');
assert.equal((await fetch(hookUrl, { method: 'POST', body: short, headers: { 'x-paystack-signature': crypto.createHmac('sha512', secret).update(short).digest('hex') } })).status, 200);
assert.equal((await query('SELECT status FROM orders WHERE public_ref = ?', [c4.body.order.ref]))[0].status, 'pending_payment');
const replies = await Promise.all(Array.from({ length: 6 }, () => fetch(hookUrl, { method: 'POST', body: payload, headers: { 'x-paystack-signature': sig } })));
assert.ok(replies.every((r) => r.status === 200));
assert.equal((await query('SELECT status FROM orders WHERE public_ref = ?', [c4.body.order.ref]))[0].status, 'paid');
step('webhook: bad signature refused, short payment held, 6 simultaneous genuine webhooks counted once');
hook.close();

// deal with pay-small-small lease, and a cart with two vendors
const mk = async (cat, name, rating, volt, price) => (await vendor('POST', '/vendor/products', { category: cat, name, rating, systemVoltage: volt, price, inStock: true, status: 'active', ...(cat === 'battery' ? { batteryType: 'lithium' } : {}) })).body.product.id;
const panelId = await mk('panel', 'Deal panel 550W', 550, null, 100000);
const invId = await mk('inverter', 'Deal inverter 5kVA', 5, 48, 400000);
const batId = await mk('battery', 'Deal battery 48V', 5, 48, 600000);
const deal = await vendor('POST', '/vendor/deals', { title: 'Home starter', items: [{ productId: panelId, qty: 6 }, { productId: invId, qty: 1 }, { productId: batId, qty: 1 }], installationIncluded: true, buyPrice: 1500000, lease: { depositPct: 30, tenors: [3, 6, 12] }, status: 'active' });
assert.equal(deal.status, 201, JSON.stringify(deal.body));
const dealPage = await client()('GET', `/shop/deals/${deal.body.deal.id}?state=lagos&areaId=yaba`);
assert.equal(dealPage.status, 200, JSON.stringify(dealPage.body));
assert.deepEqual(dealPage.body.deal.lease.map((o) => o.months), [3, 6, 12]);
assert.ok(dealPage.body.deal.lease[2].monthly < dealPage.body.deal.lease[0].monthly);
step(`deal page shows pay-small-small plans: ${dealPage.body.deal.lease.map((o) => `${o.months}mo ₦${o.monthly}`).join(', ')}`);

const sellerB = await buyer('POST', '/auth/switch', { role: 'vendor' });
assert.equal(sellerB.status, 200);
const prodB = await buyer('POST', '/vendor/products', { category: 'panel', name: 'Yaba panel', rating: 400, price: 80000, inStock: true, status: 'active' });
assert.equal(prodB.status, 201, JSON.stringify(prodB.body));
await buyer('POST', '/auth/switch', { role: 'individual' });
const two = await buyer('POST', '/checkout/quote', { items: [{ kind: 'product', id: pid, qty: 1 }, { kind: 'product', id: prodB.body.product.id, qty: 1 }] });
assert.equal(two.status, 200, JSON.stringify(two.body));
assert.equal(two.body.quote.vendorCount, 2);
assert.ok(!JSON.stringify(two.body).includes('parts'));
step(`two vendors in one cart: one combined delivery fee ₦${two.body.quote.deliveryFee}`);
const own = await buyer('POST', '/checkout/quote', { items: [{ kind: 'deal', id: deal.body.deal.id, qty: 1 }], destination: { line: '1 Abuja Rd, Garki', state: 'abuja', areaId: 'garki' } });
assert.equal(own.status, 409);
step('buying from a Lagos vendor for an Abuja address is refused');

const adminList = await ordersService.adminOrders({});
assert.ok(adminList.orders.length >= 3 && adminList.orders[0].vendor.name);
assert.ok(adminList.orders.every((o) => o.platformRevenue === o.serviceCharge + o.commission));
step('admin order list reads from the database');

// registration fee (dormant in production until switched on): exercise the real SQL here
const { createRegistrationFeeService } = await import('../src/services/registrationFee.service.js');
const { vendorsModel } = await import('../src/models/vendors.js');
const { FEE_RULES } = await import('../src/utils/fees.js');
const { paystack: ps } = await import('../src/services/index.js');
const [vrow] = await query('SELECT id FROM users WHERE email = ? AND role = ?', [vEmail, 'vendor']);
const vid = Number(vrow.id);
assert.equal((await vendorsModel.getProfile(vid)).registrationFee, 'waived'); // joined while registration was free
await query("UPDATE vendor_profiles SET registration_fee_status = 'unpaid' WHERE user_id = ?", [vid]);
const feeSvc = createRegistrationFeeService({ vendorsModel, paystack: ps, rules: FEE_RULES, config: { required: true, callbackUrl: 'http://x/return', pollMs: 20 } });
assert.equal(await feeSvc.isActive(vid), false);
const starts = await Promise.all([1, 2, 3, 4].map(() => feeSvc.start({ id: vid, email: vEmail })));
assert.equal(new Set(starts.map((x) => x.reference)).size, 1);
assert.equal(starts[0].amount, 100000);
ps.markMockPaid(starts[0].reference);
await Promise.all(Array.from({ length: 6 }, () => feeSvc.verifyAndSettle({ id: vid }, starts[0].reference)));
assert.equal((await vendorsModel.getProfile(vid)).registrationFee, 'paid');
assert.equal(Number((await query("SELECT COUNT(*) AS n FROM registration_payments WHERE vendor_id = ? AND status = 'success'", [vid]))[0].n), 1);
step('registration fee (₦100,000): 4 taps = 1 payment link; 6 simultaneous confirmations activated the vendor once');

// admin sees everything
const stats = await ordersService.adminStats();
assert.ok(stats.orders >= 3);
assert.ok(stats.platform_revenue > 0);
step(`admin stats: ${stats.orders} paid orders, ₦${stats.gmv} sales`);

server.close();
await pool.end();
realLog('\nAll end-to-end checks passed.');
