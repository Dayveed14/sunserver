// End-to-end check against a REAL database: sign-up, selling, buying, paying, the whole order life cycle.
// Run it after `npm run db:init`:   npm run e2e      (uses the DB_* settings in your .env; simulation mode for Paystack)
// It creates a few throw-away test accounts (e2e-*@example.test) and orders. Use a development database.
process.env.JWT_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-1234';
process.env.PAYSTACK_SECRET_KEY = '';
process.env.NODE_ENV = 'development';
process.env.RATE_LIMIT_SCALE ??= '20'; // this run signs up far more accounts than one person would in 15 minutes
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
const { ordersService, installationsService } = await import('../src/services/index.js');
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
    address: { line: '12 Test Street', state: extra.state ?? 'lagos', areaId: extra.areaId ?? 'ikeja' }, ...(role !== 'individual' ? { companyName: `${name} Ltd` } : {}), ...(role === 'vendor' ? { vendorType: extra.vendorType ?? 'company' } : {}),
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const ver = await api('POST', '/auth/verify-otp', { email, role, code: lastCode(email) });
  assert.ok(ver.status === 200, JSON.stringify(ver.body));
  // Vendors are approved by the admin before they can post; the shortcut here stands in for that review (tested separately below).
  if (role === 'vendor' && !extra.unverified) await query("UPDATE vendor_profiles vp JOIN users u ON u.id = vp.user_id SET vp.verification_status = 'verified' WHERE u.email = ? AND u.role = 'vendor'", [email]);
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
const dup = await client()('POST', '/auth/register', { role: 'vendor', vendorType: 'seller', fullName: 'X', email: vEmail, phone: '08031234567', password: 'Passw0rd!long', companyName: 'Y Ltd', address: { line: '1 Another Road', state: 'lagos', areaId: 'ikeja' } });
assert.ok(dup.status >= 400 && dup.status < 500);
step('same email + same role is refused');
const added = await buyer('POST', '/auth/accounts', { role: 'vendor', vendorType: 'seller', companyName: 'Chi Sells', password: 'Passw0rd!long', address: { line: '9 Market Road, Yaba', state: 'lagos', areaId: 'yaba' } });
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
assert.ok(lagos.body.products.length > 0 && lagos.body.products.every((p) => p.vendor.state === 'lagos'));
assert.ok((await client()('GET', `/shop/products/${pid}`)).body.product.imageUrl, 'the product page shows its picture');
const abuja = await client()('GET', '/shop/products?state=abuja');
assert.ok(!abuja.body.products.some((p) => p.id === pid));
const page = await client()('GET', `/shop/products/${pid}?state=lagos&areaId=yaba`);
assert.equal(page.body.delivery.available, true);
const cross = await client()('GET', `/shop/products/${pid}?state=abuja&areaId=garki`);
assert.equal(cross.body.delivery.available, false);
step(`shop is state-limited; product page says vendor is ${page.body.delivery.distanceKm} km away, delivery ₦${page.body.delivery.fee}`);

// more product types: a no-size cable, a sized charge controller, bad input, shop filters, and a deal that refuses non-core
const cable = await vendor('POST', '/vendor/products', { category: 'cable', name: 'Solar cable 6mm 100m', price: 45000, inStock: true, status: 'active' });
assert.equal(cable.status, 201, JSON.stringify(cable.body));
assert.equal(Number(cable.body.product.rating), 0);
const ctrl = await vendor('POST', '/vendor/products', { category: 'controller', name: 'MPPT 60A', rating: 60, systemVoltage: 48, price: 85000, inStock: true, status: 'active' });
assert.equal(ctrl.status, 201, JSON.stringify(ctrl.body));
assert.equal((await vendor('POST', '/vendor/products', { category: 'controller', name: 'MPPT no size', price: 85000, inStock: true, status: 'active' })).status, 400);
assert.equal((await vendor('POST', '/vendor/products', { category: 'toaster', name: 'Nope', price: 85000, inStock: true, status: 'active' })).status, 400);
const more = await client()('GET', '/shop/products?state=lagos&category=more');
assert.ok(more.body.products.some((p) => p.id === cable.body.product.id) && more.body.products.every((p) => !['panel', 'inverter', 'battery'].includes(p.category)));
const onlyCtrl = await client()('GET', '/shop/products?state=lagos&category=controller');
assert.ok(onlyCtrl.body.products.length > 0 && onlyCtrl.body.products.every((p) => p.category === 'controller'));
assert.equal((await client()('GET', '/shop/products?state=lagos&category=toaster')).status, 400);
step('22 product types: cable (no size) and charge controller list under More products, bad type and missing size refused');

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
const badDeal = await vendor('POST', '/vendor/deals', { title: 'Cable deal', items: [{ productId: cable.body.product.id, qty: 1 }, { productId: invId, qty: 1 }, { productId: batId, qty: 1 }], installationIncluded: true, buyPrice: 700000 });
assert.equal(badDeal.status, 400, JSON.stringify(badDeal.body));
const deal = await vendor('POST', '/vendor/deals', { title: 'Home starter', items: [{ productId: panelId, qty: 6 }, { productId: invId, qty: 1 }, { productId: batId, qty: 1 }], installationIncluded: true, buyPrice: 1500000, lease: { depositPct: 30, tenors: [3, 6, 12] }, status: 'active' });
assert.equal(deal.status, 201, JSON.stringify(deal.body));
const dealPage = await client()('GET', `/shop/deals/${deal.body.deal.id}?state=lagos&areaId=yaba`);
assert.equal(dealPage.status, 200, JSON.stringify(dealPage.body));
assert.deepEqual(dealPage.body.deal.lease.map((o) => o.months), [3, 6, 12]);
assert.ok(dealPage.body.deal.lease[2].monthly < dealPage.body.deal.lease[0].monthly);
step(`deal page shows pay-small-small plans: ${dealPage.body.deal.lease.map((o) => `${o.months}mo ₦${o.monthly}`).join(', ')}`);

const sellerB = await buyer('POST', '/auth/switch', { role: 'vendor' });
assert.equal(sellerB.status, 200);
// Not approved yet, so posting is refused; then the admin approves it.
const blocked = await buyer('POST', '/vendor/products', { category: 'panel', name: 'Too early', rating: 400, price: 80000, inStock: true, status: 'active' });
assert.equal(blocked.status, 403);
assert.equal(blocked.body.error.code, 'VENDOR_NOT_VERIFIED');
step('an unverified vendor cannot post');
await query("UPDATE vendor_profiles vp JOIN users u ON u.id = vp.user_id SET vp.verification_status = 'verified' WHERE u.email = ? AND u.role = 'vendor'", [cEmail]);
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

// ---------- verification: documents, admin review, company-only EaaS, installer vetting ----------
{
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const pdf = Buffer.from('%PDF-1.4\n% test document\n');
  const seller = await signUp('vendor', 'Plain Seller', `e2e-seller-${stamp}@example.test`, { vendorType: 'seller', unverified: true });
  const company = await signUp('vendor', 'Big Company', `e2e-company-${stamp}@example.test`, { vendorType: 'company', unverified: true });

  const st0 = await seller('GET', '/vendor/verification');
  assert.equal(st0.status, 200);
  assert.equal(st0.body.status, 'pending');
  assert.equal(st0.body.canSubmit, false);
  assert.equal((await seller('POST', '/vendor/verification/submit')).status, 400, 'cannot submit with no documents');
  assert.equal((await seller('POST', '/vendor/products', { category: 'panel', name: 'x', rating: 400, price: 1000, inStock: true, status: 'active' })).status, 403);
  assert.equal((await seller('POST', '/vendor/images', null, {}, { type: 'image/png', data: png })).status, 403);
  step('an unverified seller is blocked from posting products and pictures');

  assert.equal((await seller('POST', '/vendor/documents?kind=shop', null, {}, { type: 'application/pdf', data: Buffer.from('not a pdf at all, just text') })).status, 400);
  const up = await seller('POST', '/vendor/documents?kind=shop&label=Shop%20front', null, {}, { type: 'image/png', data: png });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const docId = up.body.id;
  const sub = await seller('POST', '/vendor/verification/submit');
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  step('a seller uploaded proof of shop and sent it for review (fake files refused)');

  // privacy: only the owner and the admin can read a document
  assert.equal((await seller('GET', `/vendor/documents/${docId}/file`)).status, 200);
  assert.equal((await company('GET', `/vendor/documents/${docId}/file`)).status, 404);
  assert.equal((await client()('GET', `/vendor/documents/${docId}/file`)).status, 401);
  assert.equal((await admin('GET', `/admin/documents/${docId}/file`)).status, 200);
  assert.equal((await buyer('GET', `/admin/documents/${docId}/file`)).status, 403);
  step('documents are private: other vendors get 404, visitors 401, customers 403; the admin can read them');

  // a company must send its CAC
  assert.equal((await company('POST', '/vendor/documents?kind=shop', null, {}, { type: 'image/png', data: png })).status, 201);
  const noCac = await company('POST', '/vendor/verification/submit');
  assert.equal(noCac.status, 400);
  assert.equal(noCac.body.error.code, 'DOCUMENTS_MISSING');
  assert.equal((await company('POST', '/vendor/documents?kind=cac&label=CAC', null, {}, { type: 'application/pdf', data: pdf })).status, 201);
  assert.equal((await company('POST', '/vendor/verification/submit')).status, 200);
  step('a company cannot be submitted without its CAC certificate; a PDF is accepted');

  // admin review
  const [sRow] = await query("SELECT id FROM users WHERE email = ? AND role = 'vendor'", [`e2e-seller-${stamp}@example.test`]);
  const [cRow] = await query("SELECT id FROM users WHERE email = ? AND role = 'vendor'", [`e2e-company-${stamp}@example.test`]);
  const rev = await admin('GET', `/admin/vendors/${sRow.id}/review`);
  assert.equal(rev.status, 200);
  assert.equal(rev.body.documents.length, 1);
  assert.equal((await admin('PATCH', `/admin/vendors/${sRow.id}/verification`, { status: 'rejected' })).status, 400, 'a rejection needs a reason');
  assert.equal((await admin('PATCH', `/admin/vendors/${sRow.id}/verification`, { status: 'rejected', note: 'Photo is blurry' })).status, 200);
  assert.equal((await seller('GET', '/vendor/verification')).body.note, 'Photo is blurry');
  assert.ok(mails.some((m) => m.includes('Photo is blurry')), 'the vendor was emailed the reason');
  assert.equal((await admin('PATCH', `/admin/vendors/${sRow.id}/verification`, { status: 'verified' })).status, 200);
  assert.equal((await admin('PATCH', `/admin/vendors/${cRow.id}/verification`, { status: 'verified' })).status, 200);
  assert.equal((await seller('DELETE', `/vendor/documents/${docId}`)).status, 409, 'verified documents stay');
  step('admin rejected with a reason (emailed), then approved both vendors');

  // posting works now; EaaS is company-only
  const okProd = await seller('POST', '/vendor/products', { category: 'panel', name: 'Seller panel', rating: 400, price: 80000, inStock: true, status: 'active' });
  assert.equal(okProd.status, 201, JSON.stringify(okProd.body));
  assert.equal((await seller('GET', '/vendor/eaas-rules')).status, 403);
  const eaasBody = { items: [{ kind: 'product', id: okProd.body.product.id, qty: 1 }], eaas: { tenorMonths: 36, annualReturnPct: 18, installationCost: 50000, installationMode: 'included' } };
  const eaasTry = await seller('POST', '/vendor/eaas-preview', eaasBody);
  assert.equal(eaasTry.status === 403 || eaasTry.status === 400, true);
  if (eaasTry.status === 403) assert.equal(eaasTry.body.error.code, 'EAAS_COMPANY_ONLY');
  assert.equal((await company('GET', '/vendor/eaas-rules')).status, 200);
  step('a seller cannot use Energy-as-a-Service; a company can');

  // installers: registration (details, skills check, two references, optional files), admin checks references, then decides
  const inst = await signUp('installer', 'Ife Installer', `e2e-inst-${stamp}@example.test`);
  const [iRow] = await query("SELECT id FROM users WHERE email = ? AND role = 'installer'", [`e2e-inst-${stamp}@example.test`]);
  const reg0 = await inst('GET', '/installer/registration');
  assert.equal(reg0.status, 200);
  assert.deepEqual(reg0.body.missing, ['about', 'experience', 'capacity', 'skills', 'references']);
  assert.equal(reg0.body.canSubmit, false);
  assert.equal(reg0.body.options.experience.length, 5);
  assert.equal((await buyer('GET', '/installer/registration')).status, 403, 'only installers see the registration');
  assert.equal((await client()('GET', '/installer/registration')).status, 401);

  const quiz = await inst('GET', '/installer/quiz');
  assert.equal(quiz.status, 200);
  assert.ok(quiz.body.questions.length >= 10);
  assert.ok(!JSON.stringify(quiz.body).includes('"correct"'), 'right answers never reach the installer');
  assert.equal((await inst('POST', '/installer/quiz', { answers: { isolate: 'b' } })).status, 400, 'every question must be answered');
  const answers = Object.fromEntries(quiz.body.questions.map((q) => [q.id, 'b']));
  const subQ = await inst('POST', '/installer/quiz', { answers });
  assert.equal(subQ.status, 200, JSON.stringify(subQ.body));
  assert.deepEqual(Object.keys(subQ.body), ['submitted']);
  assert.ok(!JSON.stringify((await inst('GET', '/installer/summary')).body).match(/score/i), 'no score shown to the installer');
  assert.equal((await inst('POST', '/installer/quiz', { answers })).status, 409, 'cannot resubmit while waiting');
  assert.equal((await inst('GET', '/installer/registration')).body.quizSubmitted, true);
  assert.equal((await admin('GET', '/admin/installers?status=pending')).body.installers.some((i) => i.userId === Number(iRow.id)), false, 'a half-finished registration is not in the waiting list yet');
  assert.equal((await admin('GET', '/admin/installers?status=draft')).body.installers.some((i) => i.userId === Number(iRow.id)), true, 'it is listed as not finished');
  assert.equal(mails.some((m) => m.includes('Installer quiz received') && m.includes('Ife Installer')), false, 'the admin is told when the whole registration is sent, not at the quiz');

  // each step saves on its own; only known fields and valid values are accepted
  assert.equal((await inst('PUT', '/installer/registration', { capacity: 4 })).status, 400);
  assert.equal((await inst('PUT', '/installer/registration', { verification: 'verified' })).status, 400, 'an installer cannot write their own approval');
  assert.equal((await inst('PUT', '/installer/registration', { businessStatus: 'team' })).status, 400, 'there is no individual / team choice');
  const s1 = await inst('PUT', '/installer/registration', { businessStatus: 'none', travelKm: 25 });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.deepEqual(s1.body.missing, ['experience', 'capacity', 'references']);
  await inst('PUT', '/installer/registration', { experienceBand: 'y4_6', qualification: 'training', projectTypes: ['residential', 'maintenance'], about: 'Eight years fitting inverters.' });
  const s3 = await inst('PUT', '/installer/registration', { capacity: 2, responseTime: '4h' });
  assert.deepEqual(s3.body.missing, ['references']);
  assert.equal(s3.body.registration.acceptsRepairs, true, 'repairs are on by default');
  const [{ years }] = await query('SELECT years_experience AS years FROM installer_profiles WHERE user_id = ?', [iRow.id]);
  assert.equal(Number(years), 4, 'the experience band keeps the number the old screens use');

  // references
  const r1 = { name: 'Mr Adebayo', phone: '0803 111 2222', relationship: 'Past client' };
  const r2 = { name: 'Mrs Okoro', phone: '08033334444', relationship: 'Former employer' };
  assert.equal((await inst('PUT', '/installer/references', { references: [r1, { ...r2, phone: '08031112222' }] })).status, 400, 'two references cannot share a number');
  assert.equal((await inst('PUT', '/installer/references', { references: [{ ...r1, phone: '12345' }] })).status, 400);
  assert.equal((await inst('PUT', '/installer/references', { references: [r1, r2, r1, r2] })).status, 400, 'at most three');
  assert.equal((await inst('PUT', '/installer/references', { references: [r1] })).status, 200);
  assert.equal((await inst('POST', '/installer/registration/submit', { declaration: true })).status, 400, 'one reference is not enough');
  const withRefs = await inst('PUT', '/installer/references', { references: [r1, r2] });
  assert.equal(withRefs.status, 200);
  assert.deepEqual(withRefs.body.missing, []);
  assert.equal(withRefs.body.references[0].phone, '+2348031112222');

  // optional files: private, images only for photos, a limit on each kind
  const certUp = await inst('POST', '/installer/documents?kind=certificate&label=NABCEP', null, {}, { type: 'application/pdf', data: Buffer.from('%PDF-1.4\n% certificate\n') });
  assert.equal(certUp.status, 201, JSON.stringify(certUp.body));
  assert.equal((await inst('POST', '/installer/documents?kind=photo', null, {}, { type: 'application/pdf', data: Buffer.from('%PDF-1.4\n') })).status, 400, 'a profile photo must be a picture');
  assert.equal((await inst('POST', '/installer/documents?kind=cac', null, {}, { type: 'image/png', data: png })).status, 400, 'only installer file kinds are accepted');
  const ph1 = await inst('POST', '/installer/documents?kind=photo', null, {}, { type: 'image/png', data: png });
  const ph2 = await inst('POST', '/installer/documents?kind=photo', null, {}, { type: 'image/png', data: png });
  assert.equal(ph1.status, 201);
  assert.equal(ph2.status, 201);
  assert.equal((await inst('GET', '/installer/registration')).body.documents.filter((d) => d.kind === 'photo').length, 1, 'a new profile photo replaces the old');
  for (let n = 0; n < 6; n += 1) assert.equal((await inst('POST', '/installer/documents?kind=work', null, {}, { type: 'image/png', data: png })).status, 201);
  assert.equal((await inst('POST', '/installer/documents?kind=work', null, {}, { type: 'image/png', data: png })).status, 409, 'six work pictures at most');
  assert.equal((await inst('GET', `/installer/documents/${certUp.body.id}/file`)).status, 200);
  assert.equal((await client()('GET', `/installer/documents/${certUp.body.id}/file`)).status, 401);
  assert.equal((await seller('GET', `/installer/documents/${certUp.body.id}/file`)).status, 403, 'a seller is not an installer');

  // sending it
  assert.equal((await admin('PATCH', `/admin/installers/${iRow.id}/verification`, { status: 'verified' })).status, 409, 'cannot approve before the registration is sent');
  assert.equal((await inst('POST', '/installer/registration/submit', {})).status, 400, 'the declaration must be ticked');
  const sent = await inst('POST', '/installer/registration/submit', { declaration: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.submitted, true);
  assert.equal((await inst('POST', '/installer/registration/submit', { declaration: true })).status, 409, 'cannot send twice while waiting');
  assert.ok(mails.some((m) => m.includes('Installer quiz received') && m.includes('Ife Installer')), 'the admin is told');

  // the admin reads everything, phones the references, then approves
  const list = await admin('GET', '/admin/installers?status=pending');
  const row = list.body.installers.find((i) => i.userId === Number(iRow.id));
  assert.ok(row && row.total === quiz.body.questions.length && row.references === 2 && row.referencesCalled === 0);
  const detail = await admin('GET', `/admin/installers/${iRow.id}`);
  assert.ok(detail.body.quiz.score >= 10 && detail.body.quiz.detail.length === quiz.body.questions.length);
  assert.equal(detail.body.registration.experience, '4–6 years');
  assert.deepEqual(detail.body.registration.projectTypes, ['Homes', 'Maintenance and repairs']);
  assert.equal(detail.body.references.length, 2);
  assert.equal(detail.body.documents.filter((d) => d.kind === 'work').length, 6);
  assert.equal((await vendor('GET', `/admin/installers/${iRow.id}`)).status, 403);
  assert.equal((await admin('GET', `/admin/documents/${certUp.body.id}/file`)).status, 200, 'the admin can open the certificate');
  assert.equal((await admin('PATCH', `/admin/installers/${iRow.id}/verification`, { status: 'verified' })).status, 409, 'references must be phoned first');
  const refIds = detail.body.references.map((r) => r.id);
  assert.equal((await vendor('PATCH', `/admin/installers/${iRow.id}/references/${refIds[0]}`, { called: true })).status, 403);
  assert.equal((await admin('PATCH', `/admin/installers/${iRow.id}/references/${refIds[0]}`, { called: true, note: 'Confirmed' })).status, 200);
  assert.equal((await admin('PATCH', `/admin/installers/${iRow.id}/verification`, { status: 'verified' })).status, 409, 'one of two is not enough');
  assert.equal((await admin('PATCH', `/admin/installers/${iRow.id}/references/${refIds[1]}`, { called: true })).status, 200);
  assert.equal((await admin('PATCH', `/admin/installers/${iRow.id}/references/999999999`, { called: true })).status, 404);
  assert.equal((await admin('PATCH', `/admin/installers/${iRow.id}/verification`, { status: 'verified' })).status, 200);
  assert.equal((await inst('GET', '/installer/summary')).body.verification, 'verified');
  assert.equal((await buyer('GET', '/installer/quiz')).status, 403);

  // after approval: working details can change, who they are cannot
  assert.equal((await inst('PUT', '/installer/registration', { experienceBand: 'gt10' })).status, 409);
  assert.equal((await inst('PUT', '/installer/references', { references: [r1, r2] })).status, 409);
  const toggled = await inst('PUT', '/installer/registration', { acceptsRepairs: false, capacity: 5 });
  assert.equal(toggled.status, 200);
  assert.equal((await inst('GET', '/installer/summary')).body.acceptsRepairs, false);
  assert.equal((await inst('DELETE', `/installer/documents/${certUp.body.id}`)).status, 409, 'an approved certificate stays');
  const workId = detail.body.documents.find((d) => d.kind === 'work').id;
  assert.equal((await inst('DELETE', `/installer/documents/${workId}`)).status, 204, 'work pictures can be tidied');

  // installers who joined before this stay on the old rules: no references needed
  const legacy = await signUp('installer', 'Old Installer', `e2e-inst-old-${stamp}@example.test`);
  const [lRow] = await query("SELECT id FROM users WHERE email = ? AND role = 'installer'", [`e2e-inst-old-${stamp}@example.test`]);
  await query('UPDATE installer_profiles SET flow_version = 1, quiz_submitted_at = UTC_TIMESTAMP(), registration_submitted_at = UTC_TIMESTAMP() WHERE user_id = ?', [lRow.id]);
  assert.equal((await admin('PATCH', `/admin/installers/${lRow.id}/verification`, { status: 'verified' })).status, 200);
  assert.equal((await legacy('GET', '/installer/summary')).body.verification, 'verified');
  step(`installer registered in five steps (skills check ${detail.body.quiz.score}/${detail.body.quiz.total} for the admin only), admin phoned both references, approved; older installers unaffected`);
}

// ---------- installations (phase 5): quote, pay, ranked matching, admin approval, steps, photos, completion report, confirm, review, cancellation ----------
{
  // Earlier test runs left approved installers behind; stand them down so only this run's installers are in play.
  await query("UPDATE installer_profiles SET verification_status = 'pending' WHERE verification_status = 'verified'");
  const mk = async (name, key, extra = {}, prof = {}) => {
    const email = `e2e-${key}-${stamp}@example.test`;
    const api = await signUp('installer', name, email, extra);
    const [row] = await query("SELECT id FROM users WHERE email = ? AND role = 'installer'", [email]);
    await query('UPDATE installer_profiles SET verification_status = ?, quiz_submitted_at = UTC_TIMESTAMP(), travel_km = ?, capacity = ?, response_time = ?, years_experience = ? WHERE user_id = ?',
      [extra.unverified ? 'pending' : 'verified', prof.km ?? 25, prof.cap ?? 5, prof.resp ?? '4h', prof.yrs ?? 4, row.id]);
    return { api, id: Number(row.id), email, name };
  };
  const instA = await mk('Ade Installer', 'ia', { areaId: 'yaba' }, { yrs: 9, resp: '1h' });
  const instB = await mk('Bayo Installer', 'ib', { areaId: 'lekki-phase-1' }, { yrs: 3 });
  const instFar = await mk('Short Range Installer', 'ifar', { areaId: 'ikeja' }, { km: 10 });
  const instAbuja = await mk('Abuja Installer', 'iab', { state: 'abuja', areaId: 'wuse' });
  const instNew = await mk('New Installer', 'inew', { unverified: true, areaId: 'yaba' });
  const cust2 = await signUp('individual', 'Other Customer', `e2e-cust2-${stamp}@example.test`, { areaId: 'yaba' });
  const byId = (id) => [instA, instB, instFar, instAbuja].find((i) => i.id === id);

  const bands = await client()('GET', '/installations/bands');
  assert.equal(bands.status, 200);
  assert.equal(bands.body.bands.length, 6);

  const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
  const body = { description: 'Install 8 panels, a 5 kVA inverter and two batteries on my roof', systemKw: 4, state: 'lagos', areaId: 'yaba', line: '5 Secret Close, Yaba', preferredDate: tomorrow };
  assert.equal((await buyer('POST', '/installations', { ...body, systemKw: 80 })).status, 400, 'too large for the price list');
  assert.equal((await buyer('POST', '/installations', { ...body, preferredDate: '2020-01-01' })).status, 400, 'a past date');
  assert.equal((await buyer('POST', '/installations', { ...body, description: 'short' })).status, 400);
  assert.equal((await vendor('POST', '/installations', body)).status, 403, 'a vendor cannot request installers');

  const made = await buyer('POST', '/installations', body);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const ref = made.body.request.ref;
  assert.equal(made.body.request.price, 110000, '4 kW sits in the 3-5 kW band');
  assert.equal(made.body.request.status, 'quote');
  assert.equal((await cust2('GET', `/installations/${ref}`)).status, 404, 'another customer cannot see it');
  assert.deepEqual((await instA.api('GET', '/installer/jobs')).body.jobs, [], 'unpaid jobs are not sent out');
  step('a 4 kW request is priced from the size bands (₦110,000); bad sizes, dates and roles are refused');

  assert.equal((await admin('PUT', '/admin/settings', { changes: { installPriceB3: 120000 } })).status, 200);
  const made2 = await buyer('POST', '/installations', body);
  assert.equal(made2.body.request.price, 120000);
  assert.equal((await buyer('GET', `/installations/${ref}`)).body.request.price, 110000, 'a quote keeps the price it was given');
  assert.equal((await admin('PUT', '/admin/settings', { changes: { installPriceB3: null } })).status, 200);
  assert.equal((await buyer('POST', `/installations/${made2.body.request.ref}/cancel`)).status, 200, 'an unpaid request can be cancelled');
  step('admin band price change applies to new quotes only');

  const pay = async (r) => {
    const p = await buyer('POST', `/installations/${r}/pay`);
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const m = await buyer('POST', '/installations/mock-pay', { reference: p.body.reference });
    assert.equal(m.status, 200, JSON.stringify(m.body));
  };
  const newPaidJob = async (extra = {}) => {
    const m = await buyer('POST', '/installations', { ...body, ...extra });
    await pay(m.body.request.ref);
    return m.body.request.ref;
  };
  const row = async (r) => (await query('SELECT * FROM install_requests WHERE public_ref = ?', [r]))[0];
  const matchesOf = async (r) => query('SELECT m.*, u.full_name FROM install_matches m JOIN users u ON u.id = m.installer_id JOIN install_requests q ON q.id = m.request_id WHERE q.public_ref = ? ORDER BY m.rank_no', [r]);
  const upload = (who, r, kind, data = png) => who.api('POST', `/installer/jobs/${r}/photos/${kind}`, null, {}, { type: 'image/png', data });
  // takes a job through offer → accept; returns the installer who has it
  const offerAndAccept = async (r) => {
    const rec = (await matchesOf(r)).find((m) => m.status === 'recommended');
    assert.ok(rec, 'a recommendation is waiting');
    assert.equal((await admin('POST', `/admin/installations/${r}/approve`)).status, 200);
    const who = byId(Number(rec.installer_id));
    assert.equal((await who.api('POST', `/installer/jobs/${r}/accept`, { confirmAvailable: true })).status, 200);
    return who;
  };

  // pay: four taps, one payment; six simultaneous confirmations, one matching run
  const taps = await Promise.all([1, 2, 3, 4].map(() => buyer('POST', `/installations/${ref}/pay`)));
  assert.ok(taps.every((t) => t.status === 201), JSON.stringify(taps.map((t) => t.body)));
  assert.equal(new Set(taps.map((t) => t.body.reference)).size, 1);
  const payRef = taps[0].body.reference;
  assert.ok(payRef.startsWith('IP-'));
  assert.equal((await cust2('POST', '/installations/mock-pay', { reference: payRef })).status, 404);
  const paid = await Promise.all([1, 2, 3, 4, 5, 6].map(() => buyer('POST', '/installations/mock-pay', { reference: payRef })));
  assert.ok(paid.every((p) => p.status === 200 && p.body.status === 'paid'), JSON.stringify(paid.map((p) => p.body)));
  assert.equal((await row(ref)).status, 'finding');
  const ms = await matchesOf(ref);
  assert.deepEqual(ms.map((m) => [Number(m.installer_id), m.status]), [[instA.id, 'recommended'], [instB.id, 'queued']], 'ranked list: the near, experienced installer first; short-range, other-state and unapproved ones are not on it');
  assert.ok(mails.some((m) => m.includes(`Installation ${ref}: approve`)), 'the admin is asked to approve the first one');
  assert.equal((await query('SELECT COUNT(*) AS n FROM install_offers o JOIN install_requests r ON r.id = o.request_id WHERE r.public_ref = ?', [ref]))[0].n, 0, 'nothing is broadcast any more');
  assert.deepEqual((await instA.api('GET', '/installer/jobs')).body.jobs, [], 'nothing reaches the installer until the admin approves');
  step('4 taps = 1 payment; 6 simultaneous confirmations ranked the installers once; the admin is asked to approve the best one, nothing is broadcast');

  // admin
  assert.equal((await buyer('GET', '/admin/installations')).status, 403);
  const needs = await admin('GET', '/admin/installations?needsAction=1');
  assert.ok(needs.body.requests.some((x) => x.ref === ref && x.matchState === 'recommended') && needs.body.stats);
  const adminView = await admin('GET', `/admin/installations/${ref}`);
  assert.equal(adminView.body.matches.length, 2);
  assert.ok(adminView.body.choices.length >= 2 && adminView.body.choices[0].score >= adminView.body.choices[1].score);
  assert.equal((await buyer('POST', `/admin/installations/${ref}/approve`)).status, 403);
  assert.equal((await admin('POST', `/admin/installations/${ref}/assign`, { installerId: 'x' })).status, 400);
  step('the admin sees the ranked list and needs-you queue; customers cannot use admin routes');

  // approve → offered
  const [aRes, aRes2] = await Promise.all([admin('POST', `/admin/installations/${ref}/approve`), admin('POST', `/admin/installations/${ref}/approve`)]);
  assert.deepEqual([aRes.status, aRes2.status].sort(), [200, 409], 'two approvals at once: one wins');
  assert.equal((await admin('POST', `/admin/installations/${ref}/approve`)).status, 409, 'nothing left to approve');
  const seen = await instA.api('GET', '/installer/jobs');
  assert.equal(seen.body.jobs.length, 1);
  const seenText = JSON.stringify(seen.body);
  assert.ok(!seenText.includes('Secret Close') && !seenText.includes('+234'), 'address and phone are hidden before accepting');
  assert.equal(seen.body.jobs[0].pay, 77000);
  assert.ok(seen.body.jobs[0].answerBy);
  assert.deepEqual((await instB.api('GET', '/installer/jobs')).body.jobs, [], 'only the offered installer sees it');
  assert.deepEqual((await instAbuja.api('GET', '/installer/jobs')).body.jobs, []);
  assert.equal((await instNew.api('GET', '/installer/jobs')).status, 403, 'an unapproved installer gets no jobs');
  assert.equal((await instB.api('POST', `/installer/jobs/${ref}/accept`, { confirmAvailable: true })).status, 404, 'an installer who was not offered the job cannot take it');
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/accept`, {})).status, 400);
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/accept`, { confirmAvailable: false })).status, 400, 'availability must be confirmed');
  assert.ok(mails.some((m) => m.includes('New installation job')));
  step('the approved installer alone sees the job and the pay, not the address; others are refused');

  // accept
  const acc = await Promise.all([instA.api('POST', `/installer/jobs/${ref}/accept`, { confirmAvailable: true }), instA.api('POST', `/installer/jobs/${ref}/accept`, { confirmAvailable: true })]);
  assert.ok(acc.every((a) => a.status === 200));
  assert.ok(acc[0].body.job.address.includes('Secret Close') && acc[0].body.job.customer.phone.startsWith('+234'));
  const cview = await buyer('GET', `/installations/${ref}`);
  assert.equal(cview.body.request.status, 'assigned');
  assert.ok(cview.body.request.installer?.phone, 'the customer now sees the installer');
  assert.ok(mails.some((m) => m.includes('You got the job')) && mails.some((m) => m.includes('An installer accepted')));
  assert.ok(!JSON.stringify(cview.body).includes('recommended') && !JSON.stringify(cview.body).includes('queued'), 'the customer does not see the matching');
  assert.equal((await instB.api('GET', `/installer/jobs/${ref}`)).status, 404);
  step('accepting twice is harmless; the installer gets the address; the customer sees the installer, not the matching');

  // the steps, in order
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/arrived`)).status, 409, 'cannot arrive before setting off');
  assert.equal((await instB.api('POST', `/installer/jobs/${ref}/on-my-way`)).status, 404);
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/on-my-way`)).status, 200);
  assert.ok(mails.some((m) => m.includes(`Your installer is on the way · ${ref}`)));
  assert.equal((await upload(instA, ref, 'before')).status, 409, 'before pictures only once at the site');
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/arrived`)).status, 200);
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/start`)).status, 400, 'a before picture is required to start');
  assert.equal((await upload(instA, ref, 'sideways')).status, 404);
  assert.equal((await upload(instA, ref, 'before', Buffer.from('not a picture at all'))).status, 400);
  assert.equal((await upload(instB, ref, 'before')).status, 404, 'another installer cannot add pictures');
  const b1 = await upload(instA, ref, 'before');
  assert.equal(b1.status, 201, JSON.stringify(b1.body));
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/start`)).status, 200);
  assert.equal((await upload(instA, ref, 'after')).status, 201);
  for (let n = 0; n < 5; n += 1) await upload(instA, ref, 'after');
  assert.equal((await upload(instA, ref, 'after')).status, 409, 'six pictures at most');
  step('on my way → arrived → before picture → start, in order; pictures are checked and capped');

  // completion report
  const mine = await instA.api('GET', '/installer/jobs/mine');
  const photosAfter = mine.body.jobs[0].work.afterPhotos;
  assert.equal(photosAfter.length, 6);
  assert.equal((await instA.api('DELETE', `/installer/jobs/${ref}/photos/${photosAfter[5]}`)).status, 200);
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/complete`, { summary: 'short' })).status, 400);
  assert.equal((await instB.api('POST', `/installer/jobs/${ref}/complete`, { summary: 'Installed everything neatly' })).status, 404);
  assert.equal((await buyer('POST', `/installations/${ref}/confirm`)).status, 409, 'cannot confirm before the installer reports');
  assert.equal((await buyer('POST', `/installations/${ref}/cancel`)).status, 409, 'the customer cannot cancel once the installer is on site');
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/complete`, { summary: 'Mounted 8 panels, wired the 5 kVA inverter and two batteries.' })).status, 200);
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/complete`, { summary: 'Mounted 8 panels, wired the 5 kVA inverter and two batteries.' })).status, 409);
  assert.ok(mails.some((m) => m.includes(`Installation finished? · ${ref}`)));
  const done = await buyer('GET', `/installations/${ref}`);
  assert.equal(done.body.request.status, 'installer_done');
  assert.equal(done.body.request.work.beforePhotos.length, 1);
  assert.equal(done.body.request.work.afterPhotos.length, 5);
  assert.ok(done.body.request.work.completion.summary.includes('Mounted 8 panels'));
  step('completion report needs after pictures and a summary; the customer sees the report with before and after pictures');

  // picture privacy
  const bid = done.body.request.work.beforePhotos[0];
  assert.equal((await buyer('GET', `/installations/${ref}/photos/${bid}`)).status, 200);
  assert.equal((await instA.api('GET', `/installer/jobs/${ref}/photos/${bid}`)).status, 200);
  assert.equal((await admin('GET', `/admin/installations/${ref}/photos/${bid}`)).status, 200);
  assert.equal((await cust2('GET', `/installations/${ref}/photos/${bid}`)).status, 404);
  assert.equal((await instB.api('GET', `/installer/jobs/${ref}/photos/${bid}`)).status, 404);
  assert.equal((await client()('GET', `/installations/${ref}/photos/${bid}`)).status, 401);
  step('job pictures are private to the customer, the installer and the admin');

  // problem stops the auto-close
  assert.equal((await buyer('POST', `/installations/${ref}/problem`, { note: 'short' })).status, 400);
  assert.equal((await cust2('POST', `/installations/${ref}/problem`, { note: 'The inverter keeps beeping all night' })).status, 404);
  assert.equal((await buyer('POST', `/installations/${ref}/problem`, { note: 'The inverter keeps beeping all night' })).status, 200);
  assert.equal((await buyer('POST', `/installations/${ref}/problem`, { note: 'The inverter keeps beeping all night' })).status, 409, 'reported once');
  assert.ok(mails.some((m) => m.includes(`PROBLEM REPORTED · ${ref}`)));
  await query("UPDATE install_requests SET installer_done_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 13 HOUR) WHERE public_ref = ?", [ref]);
  await installationsService.housekeeping();
  assert.equal((await row(ref)).status, 'installer_done', 'a reported problem stops the automatic close');
  assert.ok((await admin('GET', '/admin/installations?needsAction=1')).body.requests.some((x) => x.ref === ref), 'it shows in the admin queue');
  // confirm (three at once), payout, review
  assert.equal((await cust2('POST', `/installations/${ref}/confirm`)).status, 404);
  const conf = await Promise.all([1, 2, 3].map(() => buyer('POST', `/installations/${ref}/confirm`)));
  assert.ok(conf.every((c) => c.status === 200));
  assert.equal(mails.filter((m) => m.includes(`PAYOUT OWED · ${ref}`)).length, 1, 'three confirmations closed it once');
  assert.equal((await instA.api('GET', '/installer/jobs/mine')).body.earnings.owed, 77000);
  assert.equal((await admin('POST', `/admin/installations/${ref}/payout-paid`)).status, 200);
  assert.equal((await admin('POST', `/admin/installations/${ref}/payout-paid`)).status, 409, 'a payout is recorded once');
  assert.equal((await buyer('POST', `/installations/${ref}/review`, { rating: 9 })).status, 400);
  assert.equal((await cust2('POST', `/installations/${ref}/review`, { rating: 5 })).status, 404);
  assert.equal((await buyer('POST', `/installations/${ref}/review`, { rating: 5, comment: 'Neat work' })).status, 201);
  assert.equal((await buyer('POST', `/installations/${ref}/review`, { rating: 1 })).status, 409, 'one review per job');
  const mine2 = await instA.api('GET', '/installer/jobs/mine');
  assert.equal(mine2.body.earnings.paid, 77000);
  assert.deepEqual(mine2.body.rating, { average: 5, count: 1 });
  assert.equal((await buyer('GET', `/installations/${ref}`)).body.request.work.review.rating, 5);
  step('a problem stops the auto-close; confirmed once → ₦77,000 payout owed then paid once; one review, which counts in the installer’s rating');

  // 12-hour auto close
  const r2 = await newPaidJob();
  const w2 = await offerAndAccept(r2);
  await w2.api('POST', `/installer/jobs/${r2}/on-my-way`); await w2.api('POST', `/installer/jobs/${r2}/arrived`);
  await upload(w2, r2, 'before'); await w2.api('POST', `/installer/jobs/${r2}/start`); await upload(w2, r2, 'after');
  assert.equal((await w2.api('POST', `/installer/jobs/${r2}/complete`, { summary: 'Everything fitted and tested.' })).status, 200);
  await query("UPDATE install_requests SET installer_done_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 11 HOUR) WHERE public_ref = ?", [r2]);
  await installationsService.housekeeping();
  assert.equal((await row(r2)).status, 'installer_done', 'not closed before 12 hours');
  await query("UPDATE install_requests SET installer_done_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 13 HOUR) WHERE public_ref = ?", [r2]);
  await Promise.all([installationsService.housekeeping(), installationsService.housekeeping()]);
  assert.equal((await row(r2)).status, 'completed');
  assert.equal(mails.filter((m) => m.includes(`PAYOUT OWED · ${r2}`)).length, 1);
  step('a finished job nobody confirmed closed itself after 12 hours (not at 11), once');

  // auto-approval, an installer who stays silent, a decline, the list running out, then the admin assigns by hand
  const r3 = await newPaidJob();
  assert.equal((await matchesOf(r3)).find((m) => m.status === 'recommended').installer_id, instA.id);
  await query("UPDATE install_matches m JOIN install_requests q ON q.id = m.request_id SET m.admin_due_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE q.public_ref = ? AND m.status = 'recommended'", [r3]);
  assert.ok((await installationsService.housekeeping()).autoApproved >= 1);
  assert.equal((await matchesOf(r3)).find((m) => m.installer_id === instA.id).status, 'offered', 'left alone, the recommendation is approved automatically');
  await query("UPDATE install_matches m JOIN install_requests q ON q.id = m.request_id SET m.tech_due_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE q.public_ref = ? AND m.status = 'offered'", [r3]);
  assert.ok((await installationsService.housekeeping()).lapsed >= 1);
  const afterLapse = await matchesOf(r3);
  assert.equal(afterLapse.find((m) => m.installer_id === instA.id).status, 'timed_out');
  assert.equal(afterLapse.find((m) => m.installer_id === instB.id).status, 'recommended', 'the next installer is recommended to the admin');
  assert.deepEqual((await instA.api('GET', '/installer/jobs')).body.jobs.filter((j) => j.ref === r3), [], 'the one who stayed silent no longer sees it');
  assert.equal((await admin('POST', `/admin/installations/${r3}/approve`)).status, 200);
  assert.equal((await instB.api('POST', `/installer/jobs/${r3}/decline`)).status, 200);
  assert.ok(mails.some((m) => m.includes(`NO INSTALLER YET · ${r3}`) && m.includes('nobody left')), 'when the list runs out the admin is told');
  assert.equal((await admin('POST', `/admin/installations/${r3}/assign`, { installerId: instA.id })).status, 200, 'the admin picks one by hand');
  assert.equal((await instA.api('POST', `/installer/jobs/${r3}/accept`, { confirmAvailable: true })).status, 200);
  assert.equal((await row(r3)).status, 'assigned');
  step('silence → auto-approval and a time-out that moves on; a decline; list used up alerts the admin; the admin assigns by hand');

  // the admin declines a recommendation: the next one is recommended
  const r4 = await newPaidJob();
  assert.equal((await admin('POST', `/admin/installations/${r4}/decline`)).status, 200);
  assert.equal((await matchesOf(r4)).find((m) => m.status === 'recommended').installer_id, instB.id);
  assert.equal((await admin('POST', `/admin/installations/${r4}/assign`, { installerId: instAbuja.id })).status, 200, 'any approved installer can be chosen by hand');
  assert.ok((await instAbuja.api('GET', '/installer/jobs')).body.jobs.some((j) => j.ref === r4));

  // customer cancels while finding: full refund; the unpaid cancel was covered above
  assert.equal((await cust2('POST', `/installations/${r4}/cancel`)).status, 404);
  assert.equal((await buyer('POST', `/installations/${r4}/cancel`)).status, 200);
  const c4 = await row(r4);
  assert.deepEqual([c4.status, Number(c4.refund_amount), Number(c4.refund_needed)], ['cancelled', 110000, 1]);
  assert.ok(mails.some((m) => m.includes(`REFUND NEEDED · ${r4}`)));
  assert.equal((await instAbuja.api('POST', `/installer/jobs/${r4}/accept`, { confirmAvailable: true })).status, 404, 'a cancelled job cannot be taken');
  assert.equal((await admin('POST', `/admin/installations/${r4}/refunded`)).status, 200);
  assert.equal((await admin('POST', `/admin/installations/${r4}/refunded`)).status, 409);
  step('cancelling while the job is being matched refunds everything and closes the offer');

  // cancel after the installer set off: half refund, installer paid their share of what is kept; no-show: full refund
  const r5 = await newPaidJob();
  const w5 = await offerAndAccept(r5);
  assert.equal((await buyer('POST', `/installations/${r5}/no-show`)).status, 409, 'no-show only once the installer is overdue');
  await w5.api('POST', `/installer/jobs/${r5}/on-my-way`);
  assert.equal((await buyer('POST', `/installations/${r5}/no-show`)).status, 409, 'too early');
  assert.equal((await buyer('POST', `/installations/${r5}/cancel`)).status, 200);
  const c5 = await row(r5);
  assert.deepEqual([c5.status, Number(c5.refund_amount), Number(c5.payout_amount), c5.payout_status], ['cancelled', 55000, 38500, 'owed']);
  const r6 = await newPaidJob();
  const w6 = await offerAndAccept(r6);
  await w6.api('POST', `/installer/jobs/${r6}/on-my-way`);
  await query("UPDATE install_requests SET on_the_way_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 HOUR) WHERE public_ref = ?", [r6]);
  assert.equal((await buyer('GET', `/installations/${r6}`)).body.request.noShowAfter !== null, true);
  assert.equal((await buyer('POST', `/installations/${r6}/no-show`)).status, 200);
  const c6 = await row(r6);
  assert.deepEqual([c6.status, Number(c6.refund_amount), Number(c6.payout_amount)], ['cancelled', 110000, 0]);
  step('cancel after the installer set off = half refund and a trip payout; a no-show after 3 hours = full refund');

  // admin cancels mid-job: everything is refunded
  const r7 = await newPaidJob();
  const w7 = await offerAndAccept(r7);
  await w7.api('POST', `/installer/jobs/${r7}/on-my-way`); await w7.api('POST', `/installer/jobs/${r7}/arrived`);
  assert.equal((await admin('POST', `/admin/installations/${r7}/cancel`, {})).status, 400, 'a reason is required');
  assert.equal((await admin('POST', `/admin/installations/${r7}/cancel`, { reason: 'Site is unsafe' })).status, 200);
  assert.equal(Number((await row(r7)).refund_amount), 110000);
  assert.ok((await admin('GET', '/admin/installations?status=cancelled')).body.requests.find((x) => x.ref === r7).refundNeeded);
  step('the admin can cancel a job in progress; the customer is refunded in full');

  // nobody to send it to; Abuja jobs go to Abuja installers; legacy open jobs
  await query("UPDATE installer_profiles ip JOIN users u ON u.id = ip.user_id SET ip.verification_status = 'pending' WHERE u.id IN (?, ?, ?)", [instA.id, instB.id, instFar.id]);
  const r8 = await newPaidJob({ state: 'abuja', areaId: 'garki' });
  assert.equal((await matchesOf(r8)).find((m) => m.status === 'recommended').installer_id, instAbuja.id, 'Abuja jobs go to Abuja installers');
  const r9 = await newPaidJob();
  assert.equal((await matchesOf(r9)).length, 0);
  assert.ok(mails.some((m) => m.includes(`NO INSTALLER YET · ${r9}`)), 'with nobody in range the admin is told at once');
  assert.ok((await admin('GET', '/admin/installations?needsAction=1')).body.requests.some((x) => x.ref === r9));
  await query("UPDATE installer_profiles SET verification_status = 'verified' WHERE user_id = ?", [instA.id]);
  assert.equal((await admin('POST', `/admin/installations/${r9}/assign`, { installerId: instA.id })).status, 200);
  await query("UPDATE install_requests SET status = 'finding' WHERE public_ref = ?", [r9]);
  const list = await admin('GET', '/admin/installations');
  assert.ok(list.body.requests.length >= 4 && list.body.stats.finding >= 1);
  step('Abuja jobs go to Abuja installers; with nobody in range the admin is told and assigns by hand');
  await query("UPDATE installer_profiles SET verification_status = 'verified' WHERE user_id IN (?, ?)", [instB.id, instFar.id]);
}

// ---------- blog ----------
{
  await query("DELETE FROM articles WHERE slug LIKE 'how-much-does-solar-really-cost-in-lagos%'");
  const anon = client();
  const draft = { title: 'How much does solar really cost in Lagos?', summary: '', body: 'Solar prices depend on the size of the system.\n\n## What drives the price\n\nPanels, an inverter and batteries make up most of the cost. <script>alert(1)</script>', status: 'draft' };
  assert.equal((await vendor('POST', '/admin/blog', draft)).status, 403, 'only the admin writes articles');
  assert.equal((await admin('POST', '/admin/blog', { ...draft, title: 'x' })).status, 400);
  const made = await admin('POST', '/admin/blog', draft);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const art = made.body.article;
  assert.equal(art.slug, 'how-much-does-solar-really-cost-in-lagos');
  assert.ok(art.summary.length > 20, 'a summary is written when none is given');
  assert.equal((await anon('GET', `/blog/${art.slug}`)).status, 404, 'drafts are not public');
  assert.ok(!(await anon('GET', '/blog')).body.articles.some((a) => a.slug === art.slug));
  const img = await admin('POST', '/admin/images', null, {}, { type: 'image/png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]) });
  assert.equal(img.status, 201, JSON.stringify(img.body));
  const pub = await admin('PUT', `/admin/blog/${art.id}`, { ...draft, imageId: img.body.id, status: 'published' });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const page = await anon('GET', `/blog/${art.slug}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.article.imageUrl, `/api/images/${img.body.id}`);
  assert.ok(page.body.article.body.includes('<script>'), 'text is stored as written (the app shows it as plain text)');
  assert.ok((await anon('GET', '/blog')).body.articles.some((a) => a.slug === art.slug && !('body' in a)), 'the list has no full text');
  const second = await admin('POST', '/admin/blog', { ...draft, status: 'published' });
  assert.equal(second.body.article.slug, 'how-much-does-solar-really-cost-in-lagos-2', 'duplicate headings get their own address');
  const rename = await admin('PUT', `/admin/blog/${art.id}`, { ...draft, title: 'A different heading entirely', imageId: img.body.id, status: 'published' });
  assert.equal(rename.body.article.slug, art.slug, 'a live article keeps its address when the heading changes');
  assert.equal((await anon('GET', '/blog/no-such-article')).status, 404);
  assert.equal((await admin('DELETE', `/admin/blog/${second.body.article.id}`)).status, 204);
  assert.equal((await anon('GET', `/blog/${second.body.article.slug}`)).status, 404);
  // sections, categories, events, pictures in the text
  const tok = `Intro line.   \n  \nSecond paragraph.\n\n[[image:${img.body.id}|A panel on a roof]]\n\nClosing.`;
  const stamp = Date.now();
  const ev = { title: `Solar open day ${stamp}`, summary: '', body: tok, status: 'published', section: 'events', category: 'events' };
  assert.equal((await admin('POST', '/admin/blog', ev)).status, 400, 'an event needs a date');
  const evOk = await admin('POST', '/admin/blog', { ...ev, eventDate: '2026-12-05', eventPlace: 'Abuja' });
  assert.equal(evOk.status, 201, JSON.stringify(evOk.body));
  assert.equal(evOk.body.article.section, 'events');
  assert.equal(evOk.body.article.eventDate, '2026-12-05');
  assert.equal((await admin('POST', '/admin/blog', { ...ev, title: `Bad picture ${stamp}`, body: '[[image:99999999|nope]]', eventDate: '2026-12-05' })).status, 400, 'a picture that does not exist is refused');
  assert.equal((await admin('POST', '/admin/blog', { ...ev, title: `Bad section ${stamp}`, section: 'gossip', eventDate: '2026-12-05' })).status, 400);
  const story = await admin('POST', '/admin/blog', { title: `Our first customer ${stamp}`, summary: '', body: 'It started with a noisy petrol generator and a very large monthly fuel bill, until the solar system arrived.', status: 'published', section: 'stories', category: 'testimonials', eventDate: '2026-12-05' });
  assert.equal(story.status, 201, JSON.stringify(story.body));
  assert.equal(story.body.article.eventDate, null, 'only events keep a date');
  const onlyEvents = (await anon('GET', '/blog?section=events')).body.articles;
  assert.ok(onlyEvents.some((x) => x.id === evOk.body.article.id) && onlyEvents.every((x) => x.section === 'events'));
  const onlyTips = (await anon('GET', '/blog?category=testimonials')).body.articles;
  assert.ok(onlyTips.some((x) => x.id === story.body.article.id) && onlyTips.every((x) => x.category === 'testimonials'));
  assert.equal((await anon('GET', '/blog?section=nope')).status, 400);
  assert.equal((await anon('GET', "/blog?category=x'%20OR%201=1")).status, 400);
  await admin('DELETE', `/admin/blog/${evOk.body.article.id}`);
  await admin('DELETE', `/admin/blog/${story.body.article.id}`);
  step('blog: drafts stay private, publishing puts them on /blog, addresses are unique and stable, only the admin can write');
}

// ---------- assessment: budget, all-in-one units, complete packages ----------
{
  const cat = await client()('GET', '/analysis/catalog/home');
  assert.equal(cat.status, 200);
  const ap = cat.body.appliances.find((a) => a.id && a.variants?.length) ?? cat.body.groups?.[0]?.appliances?.[0];
  assert.ok(ap, 'a catalogue appliance to use');
  const items = [{ applianceId: ap.id, variantId: ap.variants[0].id, qty: 3 }];
  const saved = await buyer('POST', '/analysis/assessments', { segment: 'home', disco: 'aedc', items, budget: 50000 });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.result.budget, 50000, 'the budget comes back with the result');
  assert.equal((await buyer('POST', '/analysis/assessments', { segment: 'home', disco: 'aedc', items, budget: -5 })).status, 400);
  const aid = saved.body.id;

  // a verified vendor lists the parts, wiring, a kit and a portable unit
  const seller = await signUp('vendor', 'Complete Co', `e2e-complete-${stamp}@example.test`, { vendorType: 'company' });
  const mkp = async (b) => { const r = await seller('POST', '/vendor/products', { inStock: true, status: 'active', ...b }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.product; };
  const offers0 = await buyer('GET', `/offers/assessments/${aid}?plan=buy`);
  assert.equal(offers0.status, 200, JSON.stringify(offers0.body));
  const req0 = offers0.body.requirement;
  const wantKwp = req0.panelKwp;
  const panelW = 550;
  const nPanels = Math.ceil((wantKwp * 1000) / panelW);
  await mkp({ category: 'panel', name: 'E2E panel 550W', rating: panelW, price: 100000 });
  await mkp({ category: 'inverter', name: 'E2E plain inverter', rating: Math.max(req0.inverterKva, 1), systemVoltage: req0.suggestedVoltage, price: 300000, includesController: false });
  await mkp({ category: 'battery', name: 'E2E battery', rating: req0.batteryKwh || 0.5, systemVoltage: 12, batteryType: 'lithium', price: 250000 });
  await mkp({ category: 'cable', name: 'E2E solar cable 6mm', price: 30000 });
  await mkp({ category: 'mounting', name: 'E2E rails', price: 45000 });
  const kit = await mkp({ category: 'kit', name: 'E2E mini kit', rating: Math.max(0.3, wantKwp / 2), price: 180000 });
  await mkp({ category: 'portable_power', name: 'E2E mini power bank', rating: 0.3, price: 90000 });
  const portable = await mkp({ category: 'portable_power', name: 'E2E power station', rating: 1.0, price: 220000 });

  const tight = await buyer('GET', `/offers/assessments/${aid}?plan=buy`);
  assert.equal(tight.status, 200);
  assert.equal(tight.body.budget.status, 'too_small', JSON.stringify(tight.body.budget));
  assert.ok(tight.body.budget.shortfall > 0 && tight.body.budget.cheapest.price > 50000);
  assert.ok(tight.body.budget.reduceLoad?.cutPct > 0);
  assert.ok(tight.body.cheapestSystem.extras.some((e) => e.category === 'cable'), 'the cheapest system includes wiring');
  assert.ok(tight.body.cheapestSystem.missingExtras.includes('earthing') && tight.body.cheapestSystem.estimatedExtras > 0, 'parts nobody lists get an allowance');
  assert.ok(tight.body.extras.some((g) => g.category === 'controller' || g.category === 'cable'), 'extras are offered to complete the system');
  assert.ok(tight.body.allInOne.kits.some((k) => k.id === kit.id) || tight.body.allInOne.portable.some((k) => k.id === portable.id), 'all-in-one units are listed');
  const mid = await buyer('POST', '/analysis/assessments', { segment: 'home', disco: 'aedc', items, budget: 150000 });
  const midOffers = await buyer('GET', `/offers/assessments/${mid.body.id}?plan=buy`);
  assert.equal(midOffers.body.budget.status, 'too_small');
  assert.ok(midOffers.body.budget.alternatives.length >= 1, 'a budget that cannot buy the full system is still shown what it can buy');
  step('a budget of ₦50,000 is flagged too small with the shortfall, the cheapest complete option, alternatives and what to cut');

  const rich = await buyer('POST', '/analysis/assessments', { segment: 'home', disco: 'aedc', items, budget: 90000000 });
  const roomy = await buyer('GET', `/offers/assessments/${rich.body.id}?plan=buy`);
  assert.equal(roomy.body.budget.status, 'ok');
  const none = await buyer('POST', '/analysis/assessments', { segment: 'home', disco: 'aedc', items });
  assert.equal((await buyer('GET', `/offers/assessments/${none.body.id}?plan=buy`)).body.budget.status, 'no_budget');

  // a custom system with extras is priced with them
  const diy = roomy.body.diy;
  const pickPanel = diy.panels.find((p) => p.name === 'E2E panel 550W');
  const pickInv = diy.inverters.find((p) => p.name === 'E2E plain inverter');
  if (pickPanel && pickInv && diy.batteries.length) {
    const bat = diy.batteries.find((b) => b.name === 'E2E battery');
    const range = bat?.qtyByVoltage?.[String(req0.suggestedVoltage)];
    if (range) {
      const cable = roomy.body.extras.find((g) => g.category === 'cable').products[0];
      const sel = [{ productId: pickPanel.id, qty: pickPanel.qty.min }, { productId: pickInv.id, qty: 1 }, { productId: bat.id, qty: range.min }, { productId: cable.id, qty: 2 }];
      const q = await buyer('POST', `/offers/assessments/${rich.body.id}/diy-quote`, { items: sel });
      assert.equal(q.status, 200, JSON.stringify(q.body));
      assert.equal(q.body.valid, true, JSON.stringify(q.body.errors));
      assert.ok(q.body.lines.some((l) => l.category === 'cable' && l.qty === 2));
      assert.ok(q.body.extrasMissing.includes('controller'), 'a plain inverter needs a charge controller');
      assert.ok(q.body.extrasMissing.includes('mounting'));
      step('a custom system is priced with its wiring, and the missing parts (including a controller for a plain inverter) are listed');
    }
  }
  assert.equal((await buyer('POST', `/offers/assessments/${aid}/diy-quote`, { items: [{ productId: kit.id, qty: 1 }] })).body.valid, false, 'a kit is not a system part');
  void nPanels;
}

// ---------- guided assessment: backup time, priorities, three configurations, notify-me ----------
{
  const cat = await client()('GET', '/analysis/catalog/home');
  assert.ok(cat.body.backupOptions.length === 6 && cat.body.priorities.length >= 6, 'the picker carries backup choices and priorities');
  const pick = (id, qty, hoursKey) => { const ap = cat.body.appliances.find((a) => a.id === id); return { applianceId: id, variantId: (ap.variants.find((v) => v.default) ?? ap.variants[0]).id, qty, ...(hoursKey ? { hoursKey } : {}) }; };
  const items = [pick('led-bulb', 8, 'h7'), pick('ceiling-fan', 3, 'h10'), pick('fridge', 1), pick('tv', 1, 'h4'), pick('kettle', 1, 'h05'), pick('ac', 1, 'h7')];
  const guided = { segment: 'home', disco: 'aedc', supplyBand: 'D', items, backupKey: 'b6', priorities: ['food', 'lights_fans'], configKey: 'auto', budget: 3000000 };
  const r1 = await client()('POST', '/analysis/estimate', guided);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const cfg = r1.body.result.configurations;
  assert.deepEqual(cfg.items.map((c) => c.key).filter((k) => k !== 'budget'), ['essential', 'comfortable', 'whole']);
  assert.equal(cfg.selected, cfg.recommended);
  assert.equal(r1.body.result.solar.systemCost, cfg.items.find((c) => c.key === cfg.selected).systemCost);
  const whole = await client()('POST', '/analysis/estimate', { ...guided, configKey: 'whole' });
  assert.equal(whole.body.result.configurations.selected, 'whole');
  assert.ok(whole.body.result.solar.systemCost > r1.body.result.solar.systemCost - 1);
  assert.equal((await client()('POST', '/analysis/estimate', { ...guided, priorities: ['nope'] })).status, 400);
  // saving keeps the chosen configuration, and the offers flow works from it
  const savedG = await buyer('POST', '/analysis/assessments', { ...guided, configKey: 'essential' });
  assert.equal(savedG.status, 201, JSON.stringify(savedG.body));
  assert.equal(savedG.body.result.configurations.selected, 'essential');
  assert.equal((await buyer('GET', `/offers/assessments/${savedG.body.id}?plan=buy`)).status, 200);

  // fitted to a budget: the most of what they asked for, never over the budget, saved and usable for offers
  const tight = await client()('POST', '/analysis/estimate', { ...guided, priorities: ['food', 'lights_fans', 'ac'], budget: 1200000 });
  const fit = tight.body.result.configurations.items.find((c) => c.key === 'budget');
  assert.ok(fit && fit.systemCost <= 1200000 && fit.runs.includes('Refrigerator') && fit.partial.length > 0 && fit.next.extra > 0, JSON.stringify(fit));
  assert.equal(tight.body.result.configurations.recommended, 'budget');
  const savedB = await buyer('POST', '/analysis/assessments', { ...guided, priorities: ['food', 'lights_fans', 'ac'], budget: 1200000, configKey: 'budget' });
  assert.equal(savedB.status, 201, JSON.stringify(savedB.body));
  assert.equal(savedB.body.result.solar.systemCost, fit.systemCost);
  assert.equal((await buyer('GET', `/offers/assessments/${savedB.body.id}?plan=buy`)).status, 200);
  const broke = await client()('POST', '/analysis/estimate', { ...guided, budget: 5000 });
  assert.equal(broke.body.result.configurations.nothingFits, true);
  assert.ok(broke.body.result.configurations.fallback.leaseUpfront > 0);

  // notify-me: public, email only, repeats are fine, bad input is refused, only the admin reads the list
  const mail = `e2e-notify-${stamp}@example.test`;
  assert.equal((await client()('POST', '/interest', { category: 'cng', email: mail })).status, 201);
  assert.equal((await client()('POST', '/interest', { category: 'cng', email: mail })).status, 201);
  assert.equal((await client()('POST', '/interest', { category: 'solar', email: mail })).status, 400);
  assert.equal((await client()('POST', '/interest', { category: 'cng', email: 'nope' })).status, 400);
  assert.equal((await client()('GET', '/interest')).status, 401);
  assert.equal((await buyer('GET', '/interest')).status, 403);
  const list = await admin('GET', '/interest');
  assert.equal(list.status, 200);
  assert.equal(list.body.recent.filter((x) => x.email === mail).length, 1, 'the same email twice is stored once');
  assert.ok(list.body.counts.cng >= 1);
  step('guided assessment: three priced configurations, switching, saving, offers; notify-me stores one row per email and only the admin reads it');
}

// ---------- field site audits: request, assign, survey, result, options, reopen, privacy ----------
{
  const biz = await signUp('business', 'Plaza Traders', `e2e-biz-${stamp}@example.test`, { state: 'abuja', areaId: 'wuse' });
  const other = await signUp('business', 'Other Traders', `e2e-biz2-${stamp}@example.test`, { state: 'abuja', areaId: 'wuse' });
  const person = buyer; // an individual account
  const site = { state: 'abuja', areaId: 'wuse', line: 'Shop 14, Ceddi Plaza, Central Business District', preferredDate: '2026-12-01', notes: 'Ask for Mr Ade' };

  // only a business may ask; the form is checked
  assert.equal((await person('POST', '/audits', site)).status, 403, 'individuals use the normal assessment');
  assert.equal((await client()('POST', '/audits', site)).status, 401);
  assert.equal((await biz('POST', '/audits', { ...site, line: 'x' })).status, 400);
  const req = await biz('POST', '/audits', site);
  assert.equal(req.status, 201, JSON.stringify(req.body));
  const ref = req.body.audit.ref;
  assert.match(ref, /^AU-[A-Z0-9]{6}$/);
  assert.equal(req.body.audit.status, 'requested');
  assert.ok(mails.some((m) => m.includes(`New energy assessment request · ${ref}`)), 'the admin is told');
  assert.ok(mails.some((m) => m.includes(`We received your energy assessment request · ${ref}`)), 'the business is told');
  assert.equal((await other('GET', `/audits/${ref}`)).status, 404, 'another business cannot see it');
  assert.equal((await biz('GET', '/audits/not-a-ref')).status, 404);

  // admin creates a field agent (cannot reuse an email), the agent signs in
  const agentEmail = `e2e-agent-${stamp}@example.test`;
  assert.equal((await biz('POST', '/admin/field-agents', { fullName: 'Agent Ade', email: agentEmail })).status, 403);
  assert.equal((await admin('POST', '/admin/field-agents', { fullName: 'Agent Ade', email: `e2e-biz-${stamp}@example.test` })).status, 409, 'an email with an account cannot become an agent');
  const made = await admin('POST', '/admin/field-agents', { fullName: 'Agent Ade', email: agentEmail, phone: '+2348031234567' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const agentId = made.body.agent.id;
  assert.ok(mails.some((m) => m.includes('Your TerraVoltix field agent account')), 'the agent gets a set-password email');
  const [resetRow] = await query('SELECT id FROM password_resets WHERE user_id = ? AND used_at IS NULL', [agentId]);
  assert.ok(resetRow, 'a password link exists');
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash('Passw0rd!long', 4), agentId]);
  const agent = client();
  const login = await agent('POST', '/auth/login', { email: agentEmail, password: 'Passw0rd!long' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.user.role, 'field_agent');
  assert.equal((await client()('POST', '/auth/register', { role: 'field_agent', fullName: 'Sneaky', email: `e2e-sneak-${stamp}@example.test`, phone: '08031234567', password: 'Passw0rd!long', address: { line: '1 Street Road', state: 'lagos', areaId: 'ikeja' } })).status, 400, 'nobody can sign up as an agent');
  assert.equal((await admin('GET', '/admin/field-agents')).body.agents.some((g) => g.id === agentId), true);

  // the agent sees nothing until assigned
  assert.equal((await agent('GET', '/agent/jobs')).body.jobs.length, 0);
  assert.equal((await agent('GET', `/agent/jobs/${ref}`)).status, 404, 'an unassigned job is invisible to agents');
  assert.equal((await biz('GET', '/agent/jobs')).status, 403);

  // admin queue and assignment
  assert.ok((await admin('GET', '/admin/audits?status=requested')).body.audits.some((a) => a.ref === ref));
  assert.equal((await biz('GET', '/admin/audits')).status, 403);
  assert.equal((await admin('POST', `/admin/audits/${ref}/assign`, { agentId: 99999999 })).status, 400, 'only a real agent');
  assert.equal((await admin('POST', `/admin/audits/${ref}/assign`, { agentId: (await query("SELECT id FROM users WHERE role = 'admin' LIMIT 1"))[0].id })).status, 400, 'an admin is not an agent');
  const asg = await admin('POST', `/admin/audits/${ref}/assign`, { agentId });
  assert.equal(asg.status, 200, JSON.stringify(asg.body));
  assert.ok(mails.some((m) => m.includes(`A field agent has been assigned · ${ref}`)), 'the business is told');
  assert.ok(mails.some((m) => m.includes(`New site audit · ${ref}`)), 'the agent is told');
  const afterAssign = await biz('GET', `/audits/${ref}`);
  assert.equal(afterAssign.body.audit.agent.name, 'Agent Ade');
  assert.equal(afterAssign.body.audit.status, 'assigned');

  // the survey cannot be filled before the visit starts
  const cat = await agent('GET', '/agent/catalog');
  assert.equal(cat.status, 200);
  assert.ok(cat.body.appliances.length > 20 && cat.body.photoSlots.length >= 6 && cat.body.discos.length > 3);
  assert.ok(!JSON.stringify(cat.body).includes('watts'), 'wattage stays on the server');
  const ap = (id) => { const a = cat.body.appliances.find((x) => x.id === id); assert.ok(a, `catalogue has ${id}`); return { applianceId: a.id, variantId: a.variants[0].id }; };
  const emptyForm = {};
  assert.equal((await agent('PUT', `/agent/jobs/${ref}/draft`, { form: emptyForm })).status, 409, 'start the visit first');
  assert.equal((await agent('POST', `/agent/jobs/${ref}/start`)).status, 200);
  assert.ok(mails.some((m) => m.includes(`Your site audit has started · ${ref}`)), 'the business is told it is in progress');
  assert.equal((await biz('GET', `/audits/${ref}`)).body.audit.status, 'in_progress');

  // the form: draft saves, previews, and submit demands everything
  const small = {
    site: { plazaName: 'Ceddi Plaza', section: 'plaza', shopNumber: '14', shopStatus: 'occupied', gps: { lat: 9.06, lng: 7.49 } },
    business: { shopName: 'Ade Phones', ownerFirstName: 'Ade', ownerLastName: 'Bello', ownerPhone: '08031234567', businessType: 'Phone shop', yearsInPlaza: 4 },
    power: { disco: 'aedc', supplyBand: 'C', usesGenerator: false },
    roof: { areaM2: 40, type: 'flat' },
    appliances: [{ ...ap('w-clipper'), qty: 2, hoursKey: 'h4', critical: true }],
    comments: 'Friendly owner.',
  };
  const saved = await agent('PUT', `/agent/jobs/${ref}/draft`, { form: small });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(saved.body.missing['photo.plaza'], 'it says which photos are still missing');
  assert.equal((await agent('PUT', `/agent/jobs/${ref}/draft`, { form: { power: { supplyBand: 'Z' } } })).status, 400);
  assert.equal((await agent('PUT', `/agent/jobs/${ref}/draft`, { form: { appliances: [{ applianceId: 'x', variantId: 'y', qty: 0 }] } })).status, 400);
  const prev = await agent('POST', `/agent/jobs/${ref}/preview`, { form: small });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.ok(prev.body.result.usage.kwhPerDay > 0 && prev.body.result.audit.scenarios.length >= 2);
  assert.equal((await agent('POST', `/agent/jobs/${ref}/preview`, { form: { ...small, appliances: [{ applianceId: 'nope', variantId: 'nope', qty: 1 }] } })).status, 400, 'an unknown appliance is refused');
  const early = await agent('POST', `/agent/jobs/${ref}/submit`, { form: small });
  assert.equal(early.status, 400);
  assert.equal(early.body.error.code, 'INCOMPLETE');
  assert.ok(early.body.error.details.fields['photo.roof']);
  assert.equal((await biz('GET', `/audits/${ref}`)).body.audit.result, null, 'no result before submit');

  // photos: type is sniffed, slots are fixed, pictures are private
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  assert.equal((await agent('POST', `/agent/jobs/${ref}/photos/nonsense`, null, {}, { type: 'image/png', data: png })).status, 400);
  assert.equal((await agent('POST', `/agent/jobs/${ref}/photos/roof`, null, {}, { type: 'image/png', data: Buffer.from('not a picture at all, really') })).status, 400, 'fake pictures are refused');
  const photoIds = {};
  for (const slot of ['plaza', 'roof', 'equipment_space', 'signature']) {
    const up = await agent('POST', `/agent/jobs/${ref}/photos/${slot}`, null, {}, { type: 'image/png', data: png });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    photoIds[slot] = up.body.imageId;
  }
  const raw = await fetch(`${base}/images/${photoIds.roof}`);
  assert.equal(raw.status, 404, 'site pictures are not on the public picture address');
  assert.equal((await client()('GET', `/audit-photos/${photoIds.roof}`)).status, 401);
  assert.equal((await other('GET', `/audit-photos/${photoIds.roof}`)).status, 404, 'another business cannot open them');
  assert.equal((await person('GET', `/audit-photos/${photoIds.roof}`)).status, 403);
  assert.equal((await agent('GET', `/audit-photos/${photoIds.roof}`)).status, 200, 'the assigned agent can open it');

  // small site: results go out, but energy as a service is not offered
  const done = await agent('POST', `/agent/jobs/${ref}/submit`, { form: small });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.version, 1);
  assert.equal(done.body.result.audit.eaasEligible, false);
  assert.ok(!('eaas' in done.body.result.options), 'no energy as a service below the threshold');
  for (const who of ['business', 'agent', 'admin']) {
    const subject = who === 'business' ? `Your energy assessment results · ${ref}` : who === 'agent' ? `Audit submitted · ${ref}` : `Audit completed · ${ref}`;
    assert.ok(mails.some((m) => m.includes(subject)), `${who} gets the result`);
  }
  const mine = await biz('GET', `/audits/${ref}`);
  assert.equal(mine.body.audit.status, 'completed');
  assert.equal(mine.body.audit.result.usage.kwhPerDay, done.body.result.usage.kwhPerDay);
  assert.ok(mine.body.audit.timeline.map((e) => e.type).join() === 'requested,assigned,started,completed');
  assert.ok(!mine.body.audit.photos.signature, 'the signature is not shown back to the business');
  assert.equal((await agent('PUT', `/agent/jobs/${ref}/draft`, { form: small })).status, 409, 'an agent cannot edit a finished audit');
  assert.equal((await agent('POST', `/agent/jobs/${ref}/submit`, { form: small })).status, 409);

  // the result is an ordinary saved assessment: options work, and energy as a service is refused for it
  const aid = mine.body.audit.assessmentId;
  const buyOpts = await biz('GET', `/offers/assessments/${aid}?plan=buy`);
  assert.equal(buyOpts.status, 200, JSON.stringify(buyOpts.body));
  const eaasOpts = await biz('GET', `/offers/assessments/${aid}?plan=eaas`);
  assert.equal(eaasOpts.status, 400, 'small audited site: no energy as a service');
  assert.equal((await other('GET', `/offers/assessments/${aid}?plan=buy`)).status, 404, 'another business cannot use it');

  // admin flags and reopens; the earlier result stays; the agent corrects; a new version appears
  assert.equal((await admin('POST', `/admin/audits/${ref}/reopen`, { note: 'x' })).status, 400);
  assert.equal((await biz('POST', `/admin/audits/${ref}/reopen`, { note: 'Please recheck the clippers' })).status, 403);
  assert.equal((await admin('POST', `/admin/audits/${ref}/reopen`, { note: 'Please recheck the number of clippers' })).status, 200);
  assert.equal((await admin('POST', `/admin/audits/${ref}/reopen`, { note: 'Again again again' })).status, 409, 'only a finished audit can be reopened');
  const under = await biz('GET', `/audits/${ref}`);
  assert.equal(under.body.audit.underReview, true);
  assert.ok(under.body.audit.result, 'the earlier numbers stay visible while under review');
  assert.equal((await agent('GET', `/agent/jobs/${ref}`)).body.job.reviewNote, 'Please recheck the number of clippers');
  const bigForm = { ...small, appliances: [{ ...ap('w-hair-dryer'), qty: 20, hoursKey: 'h10' }], roof: { areaM2: 30, type: 'flat' }, power: { ...small.power, usesGenerator: true, generatorType: 'petrol', generatorKva: 5, fuelSpendPerWeek: 40000 } };
  const noGen = await agent('POST', `/agent/jobs/${ref}/submit`, { form: bigForm });
  assert.equal(noGen.status, 400, 'a generator site needs a generator picture');
  assert.ok(noGen.body.error.details.fields['photo.generator']);
  assert.equal((await agent('POST', `/agent/jobs/${ref}/photos/generator`, null, {}, { type: 'image/png', data: png })).status, 201);
  const v2 = await agent('POST', `/agent/jobs/${ref}/submit`, { form: bigForm });
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  assert.equal(v2.body.version, 2);
  assert.equal(v2.body.result.audit.eaasEligible, true, 'a large site is offered energy as a service');
  assert.ok(v2.body.result.options.eaas);
  assert.equal(v2.body.result.audit.roof.fits, false, 'a small roof is flagged');
  assert.ok(v2.body.result.audit.fuel.reportedMonthly > 0);
  assert.equal(mails.filter((m) => m.includes(`Your energy assessment results · ${ref}`)).length, 2, 'the business gets the updated result too');
  const final = await biz('GET', `/audits/${ref}`);
  assert.equal(final.body.audit.version, 2);
  assert.notEqual(final.body.audit.assessmentId, aid, 'the new version has its own saved assessment');
  assert.equal((await biz('GET', `/offers/assessments/${aid}?plan=buy`)).status, 200, 'the old assessment still works');
  assert.equal((await biz('GET', `/offers/assessments/${final.body.audit.assessmentId}?plan=eaas`)).status, 200, 'energy as a service is open for the large site');
  const detail = await admin('GET', `/admin/audits/${ref}`);
  assert.equal(detail.body.audit.versions.length, 2);
  assert.ok(detail.body.audit.form.business.shopName === 'Ade Phones' && detail.body.audit.contact.phone);
  assert.ok(detail.body.audit.timeline.some((e) => e.type === 'reopened' && e.note));

  // vendors see nothing of an audit until the customer picks an option and asks for a quote
  assert.equal((await vendor('GET', `/audits/${ref}`)).status, 403);
  assert.equal((await vendor('GET', `/agent/jobs/${ref}`)).status, 403);
  assert.equal((await vendor('GET', `/admin/audits/${ref}`)).status, 403);
  step('site audits: business asks, admin assigns an agent, agent surveys and submits, result goes to all, EaaS only for large sites, reopen keeps versions, photos stay private');
}

// ---------- partners, subscription, change password, admin user detail ----------
{
  const stampB = Date.now();
  const anon = client();
  const unpublished = await signUp('vendor', 'Hidden Pending Co', `e2e-pending-${stampB}@example.test`, { vendorType: 'seller', unverified: true });
  void unpublished;
  const subSeller = await signUp('vendor', `Monthly Seller ${stampB}`, `e2e-subseller-${stampB}@example.test`, { vendorType: 'seller' });
  const mkProduct = (api, name) => api('POST', '/vendor/products', { category: 'cable', name, price: 25000, inStock: true, status: 'active' });
  assert.equal((await mkProduct(subSeller, 'Sub cable A')).status, 201, 'with the subscription switched off a verified vendor posts freely');

  // --- partners directory: only approved, public-safe facts
  let pub = await anon('GET', '/partners');
  assert.equal(pub.status, 200);
  const names = pub.body.partners.map((p) => p.name);
  assert.ok(names.includes(`Monthly Seller ${stampB} Ltd`), 'a verified seller is listed');
  assert.ok(!names.some((n) => /Hidden Pending/.test(n)), 'a vendor waiting for approval is not listed');
  assert.ok(pub.body.partners.every((p) => !('email' in p) && !('phone' in p) && !('address' in p) && !('line' in p)), 'no private details are published');
  assert.ok(pub.body.partners.find((p) => p.name === `Monthly Seller ${stampB} Ltd`).stateName === 'Lagos');
  step('the public partners list shows approved vendors and installers only, with no private details');

  // --- switch the subscription on: sellers 20,000 a month
  assert.equal((await admin('PUT', '/admin/settings', { changes: { vendorSubscriptionSeller: 20000, subscriptionGraceDays: 7 } })).status, 200);
  const st0 = await subSeller('GET', '/vendor/subscription');
  assert.equal(st0.status, 200);
  assert.equal(st0.body.state, 'never');
  assert.equal(st0.body.monthlyPrice, 20000);
  assert.equal((await mkProduct(subSeller, 'Sub cable B')).status, 402, 'an unsubscribed vendor cannot post');
  assert.equal((await mkProduct(subSeller, 'Sub cable B')).body.error.code, 'SUBSCRIPTION_REQUIRED');
  const shopNow = await anon('GET', '/shop/products?state=lagos&limit=100');
  assert.ok(!JSON.stringify(shopNow.body).includes('Sub cable A'), 'an unsubscribed vendor is hidden from the shop');
  assert.ok(!(await anon('GET', '/partners')).body.partners.some((p) => p.name === `Monthly Seller ${stampB} Ltd`), 'and from the partners list');
  assert.equal((await subSeller('POST', '/vendor/subscription/start', { months: 5 })).status, 400);

  // --- pay (simulation mode): 3 months
  const started = await subSeller('POST', '/vendor/subscription/start', { months: 3 });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.amount, 60000);
  assert.match(started.body.reference, /^SUB-/);
  assert.equal((await buyer('POST', '/vendor/subscription/mock-pay', { reference: started.body.reference })).status, 403, 'only vendors can use it');
  const paid = await subSeller('POST', '/vendor/subscription/mock-pay', { reference: started.body.reference });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.status, 'paid');
  assert.equal((await subSeller('POST', '/vendor/subscription/verify', { reference: started.body.reference })).body.status, 'paid');
  const st1 = (await subSeller('GET', '/vendor/subscription')).body;
  assert.equal(st1.state, 'active');
  assert.equal(st1.history.length, 1, 'a payment reported twice is counted once');
  assert.ok(st1.daysLeft >= 89 && st1.daysLeft <= 90);
  assert.equal((await mkProduct(subSeller, 'Sub cable C')).status, 201, 'paid up: posting works again');
  assert.ok((await anon('GET', '/partners')).body.partners.some((p) => p.name === `Monthly Seller ${stampB} Ltd`));
  const webhookRows = await query("SELECT COUNT(*) n FROM subscription_payments WHERE reference = ? AND status = 'success'", [started.body.reference]);
  assert.equal(Number(webhookRows[0].n), 1);
  step('subscription: off by default; when on, unsubscribed vendors cannot post and vanish from shop and partners; paying 3 months brings them back, counted once');

  // --- a lapsed vendor (paid-up date long past) is hidden again; the admin can give free days
  await query("UPDATE vendor_profiles vp JOIN users u ON u.id = vp.user_id SET vp.subscription_paid_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) WHERE u.email = ?", [`e2e-subseller-${stampB}@example.test`]);
  assert.equal((await subSeller('GET', '/vendor/subscription')).body.state, 'lapsed');
  assert.equal((await mkProduct(subSeller, 'Sub cable D')).status, 402);
  const sid = (await query('SELECT id FROM users WHERE email = ?', [`e2e-subseller-${stampB}@example.test`]))[0].id;
  assert.equal((await vendor('POST', `/admin/subscriptions/${sid}/grant`, { days: 5 })).status, 403, 'only the admin can give days');
  assert.equal((await admin('POST', `/admin/subscriptions/${sid}/grant`, { days: 0 })).status, 400);
  assert.equal((await admin('POST', `/admin/subscriptions/${sid}/grant`, { days: 10 })).status, 200);
  assert.equal((await subSeller('GET', '/vendor/subscription')).body.state, 'active');
  const list = await admin('GET', '/admin/subscriptions');
  assert.equal(list.status, 200);
  assert.ok(list.body.vendors.some((v) => v.vendorId === Number(sid) && v.state === 'active'));
  step('a lapsed vendor is hidden; admin free days restore them and are listed');
  // back to free, so nothing below depends on it
  assert.equal((await admin('PUT', '/admin/settings', { changes: { vendorSubscriptionSeller: null, subscriptionGraceDays: null } })).status, 200);

  // --- change password, for any role
  const pwEmail = `e2e-pw-${stampB}@example.test`;
  const pw = await signUp('individual', 'Pat Password', pwEmail);
  assert.equal((await client()('POST', '/auth/change-password', { currentPassword: 'x', newPassword: 'Another1long' })).status, 401, 'signed-in only');
  assert.equal((await pw('POST', '/auth/change-password', { currentPassword: 'wrong-password1', newPassword: 'Another1long' })).body.error.code, 'WRONG_PASSWORD');
  assert.equal((await pw('POST', '/auth/change-password', { currentPassword: 'Passw0rd!long', newPassword: 'short' })).status, 400);
  assert.equal((await pw('POST', '/auth/change-password', { currentPassword: 'Passw0rd!long', newPassword: 'Passw0rd!long' })).body.error.code, 'SAME_PASSWORD');
  const other = client();
  assert.equal((await other('POST', '/auth/login', { email: pwEmail, password: 'Passw0rd!long' })).status, 200);
  assert.equal((await pw('POST', '/auth/change-password', { currentPassword: 'Passw0rd!long', newPassword: 'Another1long' })).status, 200);
  assert.equal((await pw('GET', '/auth/me')).status, 200, 'this device stays signed in');
  assert.equal((await other('GET', '/auth/me')).status, 401, 'other devices are signed out');
  assert.equal((await client()('POST', '/auth/login', { email: pwEmail, password: 'Passw0rd!long' })).status, 401, 'the old password stops working');
  assert.equal((await client()('POST', '/auth/login', { email: pwEmail, password: 'Another1long' })).status, 200);
  assert.equal((await admin('POST', '/auth/change-password', { currentPassword: 'not-the-admin-password1', newPassword: 'Another1long' })).status, 400, 'the admin can use it too');
  step('change password: needs the current one, refuses weak or unchanged, signs other devices out, works for every role');

  // --- admin user detail with documents
  const users = await admin('GET', `/admin/users?q=${encodeURIComponent(`Monthly Seller ${stampB}`)}`);
  const u = users.body.users.find((x) => x.email === `e2e-subseller-${stampB}@example.test`);
  assert.ok(u && u.createdAt && u.verification === 'verified' && u.vendorType === 'seller' && u.phone && u.address);
  const det = await admin('GET', `/admin/users/${u.id}`);
  assert.equal(det.status, 200);
  assert.ok(Array.isArray(det.body.documents) && det.body.user.stats.products >= 2);
  assert.equal((await vendor('GET', `/admin/users/${u.id}`)).status, 403);
  assert.equal((await admin('GET', '/admin/users/99999999')).status, 404);
  assert.ok(!JSON.stringify(det.body).includes('password'), 'no password hash is ever returned');
  step('admin sees full account details, counts and documents; nobody else can; no password data leaks');

  // --- deals of any products, typed-in items, long descriptions, and suggestions for a budget
  const longText = 'Features and what is in the box. '.repeat(100);
  const cab = await vendor('POST', '/vendor/products', { category: 'cable', name: `Bundle cable ${stampB}`, rating: 0, price: 12000, inStock: true, status: 'active', description: longText });
  assert.equal(cab.status, 201, JSON.stringify(cab.body));
  assert.equal(cab.body.product.description.length, longText.trim().length, 'a long description is saved whole');
  assert.equal((await vendor('POST', '/vendor/products', { category: 'cable', name: 'Too long', rating: 0, price: 12000, description: 'x'.repeat(5001) })).status, 400);
  const bundle = await vendor('POST', '/vendor/deals', {
    title: `Wiring bundle ${stampB}`, items: [{ productId: cab.body.product.id, qty: 2 }],
    extras: [{ name: 'Installation kit', qty: 1, unitPrice: 15000 }, { name: 'Conduit', qty: 3, unitPrice: 2000 }],
    installationIncluded: false, buyPrice: 40000, status: 'active',
  });
  assert.equal(bundle.status, 201, JSON.stringify(bundle.body));
  assert.equal(bundle.body.deal.itemsTotal, 2 * 12000 + 15000 + 3 * 2000, 'the items add up');
  assert.equal(bundle.body.deal.extras.length, 2);
  assert.equal((await vendor('POST', '/vendor/deals', { title: 'Empty deal', items: [], extras: [], buyPrice: 40000 })).status, 400, 'a deal needs at least one item');
  assert.equal((await vendor('POST', '/vendor/deals', { title: 'Bad item', items: [], extras: [{ name: 'x', qty: 1, unitPrice: 5 }], buyPrice: 40000 })).status, 400);
  const edited = await vendor('PUT', `/vendor/deals/${bundle.body.deal.id}`, { title: `Wiring bundle ${stampB}`, items: [{ productId: cab.body.product.id, qty: 1 }], extras: [{ name: 'Installation kit', qty: 1, unitPrice: 15000 }], installationIncluded: false, buyPrice: 25000, status: 'active' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.deal.itemsTotal, 27000);
  const tooHigh = await vendor('PUT', `/vendor/deals/${bundle.body.deal.id}`, { title: `Wiring bundle ${stampB}`, items: [{ productId: cab.body.product.id, qty: 1 }], extras: [{ name: 'Installation kit', qty: 1, unitPrice: 15000 }], installationIncluded: false, buyPrice: 27001, status: 'active' });
  assert.equal(tooHigh.status, 400, 'a buy price above the items total is refused');
  assert.ok(tooHigh.body.error.details.fields.buyPrice);
  const page = await anon('GET', `/shop/deals/${bundle.body.deal.id}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.deal.isSystem, false);
  assert.ok(page.body.deal.extras.some((x) => x.name === 'Installation kit'));
  assert.ok((await anon('GET', '/shop/deals?state=lagos')).body.deals.some((d) => d.id === bundle.body.deal.id), 'a bundle is listed in the shop');
  const pick = await anon('GET', '/shop/budget-picks?state=lagos&budget=35000');
  assert.equal(pick.status, 200);
  assert.ok(pick.body.deals.some((d) => d.id === bundle.body.deal.id), 'the bundle fits a ₦35,000 budget');
  assert.equal(pick.body.systemTooSmall, true, 'but no full system fits, so the red note shows');
  assert.ok(pick.body.closestSystem.shortfall > 0);
  assert.equal((await anon('GET', '/shop/budget-picks?state=lagos&budget=abc')).status, 400);
  assert.equal((await anon('GET', '/shop/budget-picks?budget=50000')).status, 400);
  const tiny = await anon('GET', '/shop/budget-picks?state=lagos&budget=1000');
  assert.equal(tiny.status, 200);
  assert.equal(tiny.body.nothingFits, true);
  step('deals can hold any products and typed-in items with an automatic total; long descriptions save; budget suggestions list deals/items or say how short the budget is');
}

// ---------- repairs (part A): request, call-out fee by distance, ranked matching, admin approval, technician visit and report ----------
{
  const { repairsService } = await import('../src/services/index.js');
  await query("UPDATE installer_profiles ip JOIN users u ON u.id = ip.user_id SET ip.verification_status = 'pending' WHERE u.email LIKE 'e2e-%@example.test'");
  const tk = async (name, key, extra = {}, profile = {}) => {
    const email = `e2e-rep-${key}-${stamp}@example.test`;
    const api = await signUp('installer', name, email, extra);
    const [row] = await query("SELECT id FROM users WHERE email = ? AND role = 'installer'", [email]);
    const p = { status: profile.unverified ? 'pending' : 'verified', km: profile.km ?? 25, cap: profile.cap ?? 5, resp: profile.resp ?? '4h', yrs: profile.yrs ?? 4, repairs: profile.repairs ?? 1 };
    await query("UPDATE installer_profiles SET verification_status = ?, quiz_submitted_at = UTC_TIMESTAMP(), travel_km = ?, capacity = ?, response_time = ?, years_experience = ?, accepts_repairs = ? WHERE user_id = ?", [p.status, p.km, p.cap, p.resp, p.yrs, p.repairs, row.id]);
    return { api, id: Number(row.id), email, name };
  };
  const T1 = await tk('Near Technician', 'n1', { areaId: 'yaba' }, { yrs: 8, resp: '1h' });
  const T2 = await tk('Farther Technician', 'n2', { areaId: 'lekki-phase-1' }, { yrs: 2 });
  const T3 = await tk('Short Range Technician', 'n3', { areaId: 'ikeja' }, { km: 10 });
  const T4 = await tk('Abuja Technician', 'n4', { state: 'abuja', areaId: 'wuse' });
  const T5 = await tk('Installs Only', 'n5', { areaId: 'yaba' }, { repairs: 0 });
  const T6 = await tk('Not Approved', 'n6', { areaId: 'yaba' }, { unverified: true });
  const cust3 = await signUp('individual', 'Other Repair Customer', `e2e-rcust-${stamp}@example.test`, { areaId: 'surulere' });

  const opts = await client()('GET', '/repairs/options');
  assert.equal(opts.status, 200);
  assert.ok(opts.body.faultTypes.length >= 5 && opts.body.fees.bands.length === 4 && opts.body.payNotice.includes('Pay only inside TerraVoltix'));

  const rb = { faultType: 'inverter', description: 'Inverter shows a red light and trips every evening', equipment: ['inverter', 'battery'], urgency: 'urgent', state: 'lagos', areaId: 'yaba', line: '9 Secret Lane, Yaba' };
  assert.equal((await client()('POST', '/repairs', rb)).status, 401);
  assert.equal((await vendor('POST', '/repairs', rb)).status, 403, 'a vendor cannot request repairs');
  assert.equal((await T1.api('POST', '/repairs', rb)).status, 403, 'a technician cannot request repairs');
  assert.equal((await buyer('POST', '/repairs', { ...rb, description: 'broken' })).status, 400);
  assert.equal((await buyer('POST', '/repairs', { ...rb, equipment: [] })).status, 400);
  assert.equal((await buyer('POST', '/repairs', { ...rb, faultType: 'nope' })).status, 400);
  assert.equal((await buyer('POST', '/repairs', { ...rb, callOutFee: 1 })).status, 400, 'the customer cannot set the fee');
  const inAbuja = await buyer('POST', '/repairs', { ...rb, state: 'abuja', areaId: 'wuse', line: '3 Test Road, Wuse' });
  assert.equal(inAbuja.status, 201, 'an Abuja request is priced from the Abuja technician');
  assert.equal(inAbuja.body.request.callOutFee, 5000);
  await buyer('POST', `/repairs/${inAbuja.body.request.ref}/cancel`);
  assert.equal((await buyer('POST', '/repairs', { ...rb, areaId: 'wuse' })).status, 400, 'an area from the wrong state is refused');

  const made = await buyer('POST', '/repairs', rb);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const R1 = made.body.request.ref;
  assert.equal(made.body.request.status, 'quote');
  assert.equal(made.body.request.callOutFee, 5000, 'a technician in the same area: the closest band');
  assert.equal(made.body.request.feeBand, 'Close by');
  assert.ok(made.body.request.payNotice.includes('Pay only inside'));
  assert.equal((await cust3('GET', `/repairs/${R1}`)).status, 404, 'another customer cannot see it');
  assert.equal((await T1.api('GET', `/installer/repairs/${R1}`)).status, 404, 'a technician cannot see an unpaid request');
  step('a repair request is priced by distance to the nearest available technician; bad input, fee tampering and other roles are refused');

  // pictures
  assert.equal((await buyer('POST', `/repairs/${R1}/photos`, null, {}, { type: 'image/png', data: Buffer.from('not a picture at all') })).status, 400);
  for (let n = 0; n < 4; n += 1) { const up = await buyer('POST', `/repairs/${R1}/photos`, null, {}, { type: 'image/png', data: png }); assert.equal(up.status, 201, JSON.stringify(up.body)); }
  assert.equal((await buyer('POST', `/repairs/${R1}/photos`, null, {}, { type: 'image/png', data: png })).status, 409, 'four pictures at most');
  const photoIds = (await buyer('GET', `/repairs/${R1}`)).body.request.photos;
  assert.equal(photoIds.length, 4);
  assert.equal((await buyer('GET', `/repairs/${R1}/photos/${photoIds[0]}`)).status, 200);
  assert.equal((await cust3('GET', `/repairs/${R1}/photos/${photoIds[0]}`)).status, 404, 'pictures are private');
  assert.equal((await client()('GET', `/repairs/${R1}/photos/${photoIds[0]}`)).status, 401);
  assert.equal((await buyer('DELETE', `/repairs/${R1}/photos/${photoIds[3]}`)).status, 200, 'a picture can be removed before paying');
  step('fault pictures: images only, four at most, private to the customer');

  // the admin changes a fee: new quotes use it, the old one is fixed
  assert.equal((await admin('PUT', '/admin/settings', { changes: { repairFeeNear: 6000 } })).status, 200);
  const made2 = await buyer('POST', '/repairs', rb);
  assert.equal(made2.body.request.callOutFee, 6000);
  assert.equal((await buyer('GET', `/repairs/${R1}`)).body.request.callOutFee, 5000, 'a quote keeps the fee it was given');
  assert.equal((await admin('PUT', '/admin/settings', { changes: { repairFeeNear: null } })).status, 200);
  assert.equal((await buyer('POST', `/repairs/${made2.body.request.ref}/cancel`)).status, 200, 'an unpaid request can be cancelled, nothing to refund');
  step('admin call-out fee change applies to new quotes only');

  // pay: four taps, one payment; six simultaneous confirmations, one opening
  const taps = await Promise.all([1, 2, 3, 4].map(() => buyer('POST', `/repairs/${R1}/pay`)));
  assert.ok(taps.every((t) => t.status === 201), JSON.stringify(taps.map((t) => t.body)));
  assert.equal(new Set(taps.map((t) => t.body.reference)).size, 1);
  const payRef = taps[0].body.reference;
  assert.ok(payRef.startsWith('RP-'));
  assert.equal(taps[0].body.amount, 5000);
  assert.equal((await cust3('POST', '/repairs/mock-pay', { reference: payRef })).status, 404);
  const paid = await Promise.all([1, 2, 3, 4, 5, 6].map(() => buyer('POST', '/repairs/mock-pay', { reference: payRef })));
  assert.ok(paid.every((p) => p.status === 200 && p.body.status === 'paid'), JSON.stringify(paid.map((p) => p.body)));
  const matches = await query('SELECT m.technician_id, m.rank_no, m.status FROM repair_matches m JOIN repair_requests r ON r.id = m.request_id WHERE r.public_ref = ? ORDER BY m.rank_no', [R1]);
  assert.deepEqual(matches.map((m) => Number(m.technician_id)), [T1.id, T2.id], 'only approved technicians who take repairs, in the right state and range, ranked nearest/most experienced first');
  assert.deepEqual(matches.map((m) => m.status), ['recommended', 'queued']);
  assert.equal(mails.filter((m) => m.includes('Repair') && m.includes(R1) && m.includes('approve')).length, 1, 'the admin was asked once');
  assert.equal((await buyer('GET', `/repairs/${R1}`)).body.request.status, 'finding');
  assert.equal((await buyer('POST', `/repairs/${R1}/pay`)).status, 409, 'already paid');
  assert.deepEqual((await T1.api('GET', '/installer/repairs')).body.offers, [], 'nothing reaches the technician until the admin approves');
  step('4 taps = 1 payment; 6 simultaneous confirmations opened it once; the ranked list has the 2 right technicians; the admin was asked once');

  // the admin's view and powers
  assert.equal((await vendor('GET', '/admin/repairs')).status, 403);
  assert.equal((await buyer('POST', `/admin/repairs/${R1}/approve`)).status, 403);
  const av = await admin('GET', `/admin/repairs/${R1}`);
  assert.equal(av.status, 200);
  assert.equal(av.body.matches.length, 2);
  assert.ok(av.body.choices.some((c) => c.id === T1.id) && !av.body.choices.some((c) => [T3.id, T4.id, T5.id, T6.id].includes(c.id)));
  assert.equal((await admin('GET', '/admin/repairs?status=needs_action')).body.requests.some((r) => r.ref === R1), true);
  assert.equal((await admin('POST', `/admin/repairs/${R1}/decline`)).status, 200, 'declining the recommendation moves to the next one');
  const afterDecline = await query('SELECT m.technician_id, m.status FROM repair_matches m JOIN repair_requests r ON r.id = m.request_id WHERE r.public_ref = ? ORDER BY m.rank_no', [R1]);
  assert.deepEqual(afterDecline.map((m) => m.status), ['passed', 'recommended']);
  assert.equal((await admin('POST', `/admin/repairs/${R1}/approve`)).status, 200);
  assert.equal((await admin('POST', `/admin/repairs/${R1}/approve`)).status, 409, 'approving twice does nothing');
  const offerSeen = await T2.api('GET', '/installer/repairs');
  assert.equal(offerSeen.body.offers.length, 1);
  const offerText = JSON.stringify(offerSeen.body);
  assert.ok(!offerText.includes('Secret Lane') && !offerText.includes('+234') && !offerText.includes('"customer"'), 'no address or phone before accepting');
  assert.ok(offerSeen.body.offers[0].youEarn === 4000 && offerSeen.body.offers[0].fee === 5000, 'the technician sees their share after the commission');
  assert.deepEqual((await T1.api('GET', '/installer/repairs')).body.offers, [], 'the passed-over technician sees nothing');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/accept`)).status, 404, 'only the offered technician can accept');
  assert.equal((await T6.api('GET', '/installer/repairs')).status, 403, 'an unapproved technician gets nothing');
  step('admin declined the first recommendation (next ranked recommended) then approved; only that technician sees the offer, without address or phone');

  // technician declines, list is used up, the admin is told and chooses by hand
  assert.equal((await T2.api('POST', `/installer/repairs/${R1}/decline`)).status, 200);
  assert.equal((await T2.api('POST', `/installer/repairs/${R1}/accept`)).status, 404, 'a declined offer cannot be taken back');
  assert.ok(mails.some((m) => m.includes(`NO TECHNICIAN YET · ${R1}`)), 'the admin is alerted when the ranked list is used up');
  assert.equal((await admin('POST', `/admin/repairs/${R1}/assign`, { technicianId: T3.id })).status, 200, 'the admin may pick any technician who takes repairs');
  assert.equal((await admin('POST', `/admin/repairs/${R1}/assign`, { technicianId: T1.id })).status, 200, 'and may change their mind: the job is offered to the new choice');
  assert.deepEqual((await T3.api('GET', '/installer/repairs')).body.offers, [], 'the earlier choice no longer has the offer');
  assert.equal((await admin('POST', `/admin/repairs/${R1}/assign`, { technicianId: T6.id })).status, 404, 'an unapproved technician cannot be chosen');
  const race = await Promise.all([T1.api('POST', `/installer/repairs/${R1}/accept`), T1.api('POST', `/installer/repairs/${R1}/accept`)]);
  assert.ok(race.every((r) => r.status === 200), 'accepting twice is harmless');
  const accepted = race.find((r) => r.body.job && !r.body.already);
  assert.ok(accepted, 'exactly one accept did the work');
  assert.ok(accepted.body.job.address.includes('Secret Lane') && accepted.body.job.customer.phone.startsWith('+234'), 'the technician gets the address and phone after accepting');
  assert.equal((await admin('POST', `/admin/repairs/${R1}/assign`, { technicianId: T2.id })).status, 409, 'cannot reassign once accepted');
  const cv = await buyer('GET', `/repairs/${R1}`);
  assert.equal(cv.body.request.status, 'assigned');
  assert.equal(cv.body.request.technician.name, 'Near Technician');
  assert.ok(!JSON.stringify(cv.body).includes('recommended') && !JSON.stringify(cv.body).includes('score'), 'the customer never sees the matching');
  assert.ok(mails.some((m) => m.includes(`Technician assigned · ${R1}`)));
  step('technician declined → list used up → admin alerted and chose by hand; accepting twice is harmless; customer now sees the technician');

  // the visit: on my way → arrived → inspection pictures → report
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/arrived`)).status, 409, 'must set off first');
  assert.equal((await T2.api('POST', `/installer/repairs/${R1}/on-my-way`)).status, 404, 'only the assigned technician');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/on-my-way`)).status, 200);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/on-my-way`)).status, 200, 'tapping twice is harmless');
  assert.ok(mails.some((m) => m.includes(`Technician on the way · ${R1}`)));
  const rep = { findings: 'The inverter control board has failed and one battery cell is weak.', parts: [{ name: 'Inverter control board', qty: 1, unitPrice: 45000 }, { name: 'Fuse 40A', qty: 2, unitPrice: 1500 }], labour: 10000, estimatedHours: 6 };
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/report`, rep)).status, 409, 'cannot report before arriving');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/arrived`)).status, 200);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/photos`, null, {}, { type: 'image/png', data: png })).status, 201);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/photos`, null, {}, { type: 'image/png', data: Buffer.from('nope nope nope') })).status, 400);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/report`, { ...rep, findings: 'broken' })).status, 400);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/report`, { ...rep, estimatedHours: 0 })).status, 400, 'a time estimate is required');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/report`, { ...rep, parts: [{ name: 'Board', qty: 1, unitPrice: -5 }] })).status, 400);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/report`, { ...rep, total: 1 })).status, 400, 'the technician cannot write the total; the system adds it up');
  assert.equal((await T2.api('POST', `/installer/repairs/${R1}/report`, rep)).status, 404);
  const sentReport = await T1.api('POST', `/installer/repairs/${R1}/report`, rep);
  assert.equal(sentReport.status, 200, JSON.stringify(sentReport.body));
  assert.equal(sentReport.body.report.total, 58000);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/report`, rep)).status, 409, 'one report per visit');
  const afterReport = await buyer('GET', `/repairs/${R1}`);
  assert.equal(afterReport.body.request.status, 'inspected');
  const view = afterReport.body.request.report;
  assert.equal(view.total, 58000);
  assert.equal(view.callOutCredit, 5000, 'the call-out fee is credited');
  assert.equal(view.amountDue, 53000);
  assert.deepEqual(view.parts.map((p) => p.amount), [45000, 3000]);
  assert.equal(view.photos.length, 1);
  assert.ok(afterReport.body.request.timeline.map((t) => t.type).join() === 'requested,paid,accepted,on_the_way,arrived,inspected');
  assert.equal((await buyer('GET', `/repairs/${R1}/photos/${view.photos[0]}`)).status, 200, 'the customer sees the technician\'s inspection pictures');
  assert.equal((await buyer('POST', `/repairs/${R1}/cancel`)).status, 409, 'after the visit it can no longer be cancelled here');
  assert.equal((await buyer('POST', `/repairs/${R1}/photos`, null, {}, { type: 'image/png', data: png })).status, 409);
  assert.equal((await T1.api('GET', '/installer/repairs/mine')).body.jobs[0].report.youEarn, 46400, 'the technician sees their share of the repair after the one commission');
  assert.ok(mails.some((m) => m.includes(`Your repair estimate · ${R1}`)));
  step('on my way → arrived → report: total ₦58,000 is added up by the system, the call-out fee ₦5,000 is credited, customer sees ₦53,000 due, the timeline and the inspection pictures');

  // auto-approval and technician silence use the housekeeping timer
  const pay = async (api, ref) => {
    const p = await api('POST', `/repairs/${ref}/pay`);
    return api('POST', '/repairs/mock-pay', { reference: p.body.reference });
  };
  const R2 = (await buyer('POST', '/repairs', { ...rb, urgency: 'normal' })).body.request.ref;
  assert.equal((await pay(buyer, R2)).status, 200);
  assert.deepEqual((await T1.api('GET', '/installer/repairs')).body.offers, []);
  await query("UPDATE repair_matches m JOIN repair_requests r ON r.id = m.request_id SET m.admin_due_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE r.public_ref = ? AND m.status = 'recommended'", [R2]);
  const h1 = await repairsService.housekeeping();
  assert.equal(h1.autoApproved >= 1, true, 'the admin did not act in time: the recommendation is approved automatically');
  assert.equal((await repairsService.housekeeping()).autoApproved, 0, 'and only once');
  const [first] = await query("SELECT m.technician_id FROM repair_matches m JOIN repair_requests r ON r.id = m.request_id WHERE r.public_ref = ? AND m.status = 'offered'", [R2]);
  const firstTech = [T1, T2].find((t) => t.id === Number(first.technician_id));
  assert.equal((await firstTech.api('GET', '/installer/repairs')).body.offers.length, 1);
  await query("UPDATE repair_matches m JOIN repair_requests r ON r.id = m.request_id SET m.tech_due_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE r.public_ref = ? AND m.status = 'offered'", [R2]);
  const h2 = await repairsService.housekeeping();
  assert.equal(h2.lapsed >= 1, true, 'the technician did not answer: the offer moves on');
  assert.ok(mails.some((m) => m.includes(`Repair ${R2}: technician did not answer`)), 'the admin is told');
  assert.deepEqual((await firstTech.api('GET', '/installer/repairs')).body.offers, [], 'the silent technician loses the offer');
  assert.equal((await firstTech.api('POST', `/installer/repairs/${R2}/accept`)).status, 404);
  const [rec] = await query("SELECT m.technician_id, m.status FROM repair_matches m JOIN repair_requests r ON r.id = m.request_id WHERE r.public_ref = ? AND m.status = 'recommended'", [R2]);
  assert.ok(rec && Number(rec.technician_id) !== firstTech.id, 'the next-ranked technician is now recommended (admin still decides)');
  step('no admin action → approved automatically (once); technician silent → offer lapses, admin told, next-ranked recommended');

  // cancelling: full refund before they set off, half after, none once they have arrived
  assert.equal((await admin('POST', `/admin/repairs/${R2}/cancel`, { reason: 'Customer asked us to stop' })).status, 200);
  const [c2] = await query('SELECT refund_amount, refund_needed FROM repair_requests WHERE public_ref = ?', [R2]);
  assert.deepEqual([Number(c2.refund_amount), Number(c2.refund_needed)], [5000, 1], 'an admin cancel refunds the whole call-out fee');
  assert.ok(mails.some((m) => m.includes(`REFUND NEEDED · ${R2}`)));
  assert.equal((await admin('POST', `/admin/repairs/${R2}/refunded`)).status, 200);
  assert.equal((await admin('POST', `/admin/repairs/${R2}/refunded`)).status, 409, 'a refund is recorded once');

  const toAssigned = async () => {
    const ref = (await buyer('POST', '/repairs', { ...rb, urgency: 'normal' })).body.request.ref;
    await pay(buyer, ref);
    assert.equal((await admin('POST', `/admin/repairs/${ref}/assign`, { technicianId: T1.id })).status, 200);
    assert.equal((await T1.api('POST', `/installer/repairs/${ref}/accept`)).status, 200);
    return ref;
  };
  const R3 = await toAssigned();
  const x3 = await buyer('POST', `/repairs/${R3}/cancel`);
  assert.deepEqual([x3.status, x3.body.refund], [200, 5000], 'cancelled before the technician set off: full refund');
  assert.ok(mails.some((m) => m.includes(`Job cancelled · ${R3}`)), 'the technician is told');
  assert.equal((await T1.api('POST', `/installer/repairs/${R3}/on-my-way`)).status, 409, 'and cannot set off for a cancelled job');
  const R4 = await toAssigned();
  assert.equal((await T1.api('POST', `/installer/repairs/${R4}/on-my-way`)).status, 200);
  const x4 = await buyer('POST', `/repairs/${R4}/cancel`);
  assert.deepEqual([x4.status, x4.body.refund], [200, 2500], 'cancelled after the technician set off: half refunded');
  const R5 = await toAssigned();
  await T1.api('POST', `/installer/repairs/${R5}/on-my-way`);
  await T1.api('POST', `/installer/repairs/${R5}/arrived`);
  assert.equal((await buyer('POST', `/repairs/${R5}/cancel`)).status, 409, 'not once they have arrived');
  assert.equal((await buyer('GET', '/repairs')).body.requests.filter((r) => r.refund?.pending).length >= 2, true);
  step('cancelling: unpaid free; before "on my way" full refund; after it half; after arrival refused; refunds are queued once for the admin');

  // capacity: a full technician is not queued, but the admin still sees them
  await query('UPDATE installer_profiles SET capacity = 1 WHERE user_id = ?', [T1.id]);
  const R6 = (await buyer('POST', '/repairs', { ...rb, urgency: 'normal' })).body.request.ref;
  await pay(buyer, R6);
  const full = await query('SELECT m.technician_id FROM repair_matches m JOIN repair_requests r ON r.id = m.request_id WHERE r.public_ref = ?', [R6]);
  assert.deepEqual(full.map((m) => Number(m.technician_id)), [T2.id], 'a technician already at capacity is not queued');
  const choices = (await admin('GET', `/admin/repairs/${R6}`)).body.choices;
  assert.equal(choices.find((c) => c.id === T1.id)?.atCapacity, true);
  await query('UPDATE installer_profiles SET capacity = 5 WHERE user_id = ?', [T1.id]);
  await admin('POST', `/admin/repairs/${R6}/cancel`, { reason: 'Test finished' });

  // nobody in range: the request is refused up front
  await query("UPDATE installer_profiles ip JOIN users u ON u.id = ip.user_id SET ip.accepts_repairs = 0 WHERE u.email LIKE 'e2e-rep-%@example.test'");
  const nobody = await buyer('POST', '/repairs', rb);
  assert.equal(nobody.status, 409);
  assert.equal(nobody.body.error.code, 'NO_TECHNICIAN', 'with nobody taking repairs the request is refused, not left to hang');
  await query("UPDATE installer_profiles ip JOIN users u ON u.id = ip.user_id SET ip.accepts_repairs = 1 WHERE u.email LIKE 'e2e-rep-%@example.test'");
  step('a full technician is not queued but admin still sees them; with no technician available the request is refused up front');

  // a payment for the wrong amount is held, and a late payment on a cancelled request is flagged
  const R7 = (await buyer('POST', '/repairs', rb)).body.request.ref;
  const p7 = await buyer('POST', `/repairs/${R7}/pay`);
  const short = await repairsService.handleResult({ reference: p7.body.reference, status: 'success', amountKobo: 100, currency: 'NGN' });
  assert.equal(short.mismatch, true);
  assert.equal((await buyer('GET', `/repairs/${R7}`)).body.request.status, 'awaiting_payment', 'a short payment does not open the request');
  assert.equal((await buyer('POST', `/repairs/${R7}/cancel`)).status, 200);
  const late = await repairsService.handleResult({ reference: p7.body.reference, status: 'success', amountKobo: 500000, currency: 'NGN' });
  assert.equal(late.settled, true);
  assert.ok(mails.some((m) => m.includes('already paid or cancelled') || m.includes('Refund it')), 'a payment on a cancelled request is flagged for refund');
  step('wrong-amount repair payments are held; a late payment on a cancelled request is flagged');

  // ===== repairs, part B =====
  const row = async (ref) => (await query('SELECT * FROM repair_requests WHERE public_ref = ?', [ref]))[0];
  const quick = async (labour, parts = []) => {
    const ref = await toAssigned();
    await T1.api('POST', `/installer/repairs/${ref}/on-my-way`);
    await T1.api('POST', `/installer/repairs/${ref}/arrived`);
    const rr = await T1.api('POST', `/installer/repairs/${ref}/report`, { findings: 'Found a loose connection at the battery terminals.', parts, labour, estimatedHours: 2 });
    assert.equal(rr.status, 200, JSON.stringify(rr.body));
    return ref;
  };
  const finish = async (ref) => {
    assert.equal((await T1.api('POST', `/installer/repairs/${ref}/completion-photos`, null, {}, { type: 'image/png', data: png })).status, 201);
    const d = await T1.api('POST', `/installer/repairs/${ref}/complete`, { summary: 'Replaced the part, tested under load for an hour, all good.' });
    assert.equal(d.status, 200, JSON.stringify(d.body));
  };

  // approving the estimate: who may, how many taps, wrong amounts, one payment
  assert.equal((await cust3('POST', `/repairs/${R1}/approve-quote`)).status, 404, 'another customer cannot approve it');
  assert.equal((await vendor('POST', `/repairs/${R1}/approve-quote`)).status, 403);
  assert.equal((await T1.api('POST', `/repairs/${R1}/approve-quote`)).status, 403, 'a technician cannot approve their own estimate');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/start`)).status, 409, 'cannot start before the customer approves and pays');
  const aq = await Promise.all([1, 2, 3].map(() => buyer('POST', `/repairs/${R1}/approve-quote`)));
  assert.ok(aq.every((t) => t.status === 201), JSON.stringify(aq.map((t) => t.body)));
  assert.equal(new Set(aq.map((t) => t.body.reference)).size, 1, 'three taps, one payment');
  assert.equal(aq[0].body.amount, 53000, 'the call-out fee is credited');
  const shortQ = await repairsService.handleResult({ reference: aq[0].body.reference, status: 'success', amountKobo: 100, currency: 'NGN' });
  assert.equal(shortQ.mismatch, true);
  assert.equal((await row(R1)).status, 'inspected', 'a wrong amount does not approve the estimate');
  const paidQ = await Promise.all([1, 2, 3, 4].map(() => buyer('POST', '/repairs/mock-pay', { reference: aq[0].body.reference })));
  assert.ok(paidQ.every((p) => p.status === 200 && p.body.status === 'paid'), JSON.stringify(paidQ.map((p) => p.body)));
  const a1 = await row(R1);
  assert.deepEqual([a1.status, Number(a1.agreed_total), Number(a1.paid_amount)], ['approved', 58000, 58000], 'counted once');
  assert.equal((await buyer('POST', `/repairs/${R1}/approve-quote`)).status, 409, 'already approved');
  assert.equal((await buyer('POST', `/repairs/${R1}/decline-quote`)).status, 409);
  assert.ok(mails.some((m) => m.includes(`Estimate approved and paid · ${R1}`)), 'the technician is told to start');
  step('estimate approval: only the customer; 3 taps = 1 payment of ₦53,000 (call-out credited); wrong amount held; counted once → approved');

  // the repair: start, parts, variations
  assert.equal((await T2.api('POST', `/installer/repairs/${R1}/start`)).status, 404, 'only the assigned technician');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/start`)).status, 200);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/start`)).status, 200, 'tapping twice is harmless');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/awaiting-parts`, { note: 'x' })).status, 400);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/awaiting-parts`, { note: 'Waiting for a new control board from the supplier' })).status, 200);
  assert.equal((await buyer('GET', `/repairs/${R1}`)).body.request.status, 'awaiting_parts');
  assert.ok(mails.some((m) => m.includes(`Waiting for parts · ${R1}`)));
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/complete`, { summary: 'Finished everything today.' })).status, 409, 'cannot finish while waiting for parts');
  const vbody = { reason: 'The battery bank also needs a new busbar and extra labour.', parts: [{ name: 'Busbar', qty: 1, unitPrice: 8000 }], labour: 4000 };
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/variations`, { ...vbody, parts: [], labour: 0 })).status, 400, 'a change needs an extra cost');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/variations`, { ...vbody, extraTotal: 1 })).status, 400, 'the system adds it up');
  const v1 = await T1.api('POST', `/installer/repairs/${R1}/variations`, vbody);
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  assert.equal(v1.body.extraTotal, 12000);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/variations`, vbody)).status, 409, 'one pending revision at a time');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/parts-arrived`)).status, 200);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/parts-arrived`)).status, 409);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/complete`, { summary: 'Finished everything today.' })).status, 409, 'cannot finish with a revision still waiting');
  const wv = (await buyer('GET', `/repairs/${R1}`)).body.request.work;
  assert.deepEqual([wv.variations.length, wv.variations[0].extraTotal, wv.variations[0].status], [1, 12000, 'proposed']);
  assert.equal(wv.agreedTotal, 58000, 'nothing changes until the customer approves');
  assert.equal((await cust3('POST', `/repairs/${R1}/variations/${v1.body.id}/approve`)).status, 404);
  const va = await Promise.all([1, 2, 3].map(() => buyer('POST', `/repairs/${R1}/variations/${v1.body.id}/approve`)));
  assert.ok(va.every((t) => t.status === 201 && t.body.amount === 12000), JSON.stringify(va.map((t) => t.body)));
  assert.equal(new Set(va.map((t) => t.body.reference)).size, 1);
  assert.equal((await buyer('POST', '/repairs/mock-pay', { reference: va[0].body.reference })).status, 200);
  assert.equal((await buyer('POST', '/repairs/mock-pay', { reference: va[0].body.reference })).status, 200, 'paying twice is counted once');
  const a2 = await row(R1);
  assert.deepEqual([Number(a2.agreed_total), Number(a2.paid_amount)], [70000, 70000]);
  assert.equal((await buyer('POST', `/repairs/${R1}/variations/${v1.body.id}/decline`)).status, 409, 'an approved revision cannot be declined');
  // declined and withdrawn revisions
  const v2 = await T1.api('POST', `/installer/repairs/${R1}/variations`, vbody);
  assert.equal((await buyer('POST', `/repairs/${R1}/variations/${v2.body.id}/decline`)).status, 200);
  assert.equal((await buyer('POST', `/repairs/${R1}/variations/${v2.body.id}/approve`)).status, 409, 'a declined revision cannot be paid');
  const v3 = await T1.api('POST', `/installer/repairs/${R1}/variations`, vbody);
  assert.equal((await T2.api('POST', `/installer/repairs/${R1}/variations/${v3.body.id}/withdraw`)).status, 404);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/variations/${v3.body.id}/withdraw`)).status, 200);
  assert.equal((await row(R1)).agreed_total, 70000);
  step('repair: start; waiting for parts and back; a revision of ₦12,000 waits for the customer, is paid once (₦70,000 agreed); declined and withdrawn revisions change nothing');

  // finishing, confirming, payout, review
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/complete`, { summary: 'Replaced the board and busbar, tested for an hour.' })).status, 400, 'a picture of the finished work is required');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/completion-photos`, null, {}, { type: 'image/png', data: Buffer.from('nope nope nope') })).status, 400);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/complete`, { summary: 'short' })).status, 400);
  assert.equal((await buyer('POST', `/repairs/${R1}/confirm`)).status, 409, 'nothing to confirm yet');
  await finish(R1);
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/complete`, { summary: 'Replaced the board and busbar, tested for an hour.' })).status, 409, 'reported once');
  assert.equal((await T1.api('POST', `/installer/repairs/${R1}/completion-photos`, null, {}, { type: 'image/png', data: png })).status, 409, 'no pictures after finishing');
  const fv = (await buyer('GET', `/repairs/${R1}`)).body.request;
  assert.equal(fv.status, 'repair_done');
  assert.ok(fv.work.completion.summary.includes('Replaced') && fv.work.confirmDueAt, 'the customer sees what was done and when it closes by itself');
  assert.equal((await buyer('GET', `/repairs/${R1}/photos/${fv.work.completion.photos[0]}`)).status, 200);
  assert.equal((await cust3('GET', `/repairs/${R1}/photos/${fv.work.completion.photos[0]}`)).status, 404);
  assert.ok(mails.some((m) => m.includes(`Your repair is finished · ${R1}`)));
  assert.equal((await buyer('POST', `/repairs/${R1}/cancel`)).status, 409, 'cannot cancel a finished repair');
  assert.equal((await buyer('POST', `/repairs/${R1}/review`, { rating: 5 })).status, 409, 'review only after completion');
  assert.equal((await cust3('POST', `/repairs/${R1}/confirm`)).status, 404);
  assert.equal((await buyer('POST', `/repairs/${R1}/confirm`)).status, 200);
  assert.equal((await buyer('POST', `/repairs/${R1}/confirm`)).body.already, true, 'confirming twice is harmless');
  const done1 = await row(R1);
  assert.deepEqual([done1.status, Number(done1.payout_amount), done1.payout_status], ['completed', 56000, 'owed'], 'the technician is owed their share of ₦70,000 after the one commission');
  assert.equal((await T1.api('GET', '/installer/repairs/mine')).body.earnings.owed >= 56000, true);
  assert.equal((await buyer('POST', `/admin/repairs/${R1}/payout-paid`)).status, 403);
  assert.equal((await admin('POST', `/admin/repairs/${R1}/payout-paid`)).status, 200);
  assert.equal((await admin('POST', `/admin/repairs/${R1}/payout-paid`)).status, 409, 'a payout is recorded once');
  assert.equal((await buyer('POST', `/repairs/${R1}/review`, { rating: 6 })).status, 400);
  assert.equal((await buyer('POST', `/repairs/${R1}/review`, { rating: 5, comment: 'Quick, tidy and explained everything.' })).status, 201);
  assert.equal((await buyer('POST', `/repairs/${R1}/review`, { rating: 1 })).status, 409, 'one review per repair');
  assert.equal((await cust3('POST', `/repairs/${R1}/review`, { rating: 1 })).status, 404);
  const mine = (await T1.api('GET', '/installer/repairs/mine')).body;
  assert.deepEqual([mine.rating.average, mine.rating.count], [5, 1]);
  const cand = await (await import('../src/models/repairs.js')).repairsModel.candidates();
  assert.equal(cand.find((c) => c.id === T1.id).rating, 5, 'the review now counts in the ranking');
  assert.ok(JSON.stringify((await buyer('GET', `/repairs/${R1}`)).body.request.timeline.map((t) => t.type)).includes('confirmed'));
  step('finish needs a picture; customer confirms (twice is harmless); payout ₦56,000 owed then recorded once by the admin; review once, 1–5, and it feeds the ranking');

  // no payment needed when the call-out fee already covers the estimate; auto-confirm after the set time
  const R8 = await quick(4000);
  const free = await buyer('POST', `/repairs/${R8}/approve-quote`);
  assert.deepEqual([free.status, free.body.approved], [201, true]);
  const f8 = await row(R8);
  assert.deepEqual([f8.status, Number(f8.agreed_total)], ['approved', 5000], 'the visit fee is the minimum job value');
  assert.equal((await T1.api('POST', `/installer/repairs/${R8}/start`)).status, 200);
  await finish(R8);
  assert.equal((await repairsService.housekeeping()).autoConfirmed >= 0, true);
  assert.equal((await row(R8)).status, 'repair_done', 'not closed before its time');
  await query('UPDATE repair_requests SET confirm_due_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE public_ref = ?', [R8]);
  assert.equal((await repairsService.housekeeping()).autoConfirmed >= 1, true);
  assert.equal((await repairsService.housekeeping()).autoConfirmed, 0, 'and only once');
  const c8 = await row(R8);
  assert.deepEqual([c8.status, Number(c8.payout_amount), c8.payout_status], ['completed', 4000, 'owed']);
  assert.ok(mails.some((m) => m.includes(`Repair closed · ${R8}`)));
  step('an estimate the call-out fee covers needs no payment; a repair the customer ignores closes by itself after the set time and the payout is recorded once');

  // a reported problem stops the automatic close; the admin sorts it out
  const R9 = await quick(4000);
  await buyer('POST', `/repairs/${R9}/approve-quote`);
  await T1.api('POST', `/installer/repairs/${R9}/start`);
  await finish(R9);
  assert.equal((await buyer('POST', `/repairs/${R9}/problem`, { note: 'bad' })).status, 400);
  assert.equal((await cust3('POST', `/repairs/${R9}/problem`, { note: 'The inverter still trips every evening.' })).status, 404);
  assert.equal((await buyer('POST', `/repairs/${R9}/problem`, { note: 'The inverter still trips every evening.' })).status, 200);
  assert.equal((await buyer('POST', `/repairs/${R9}/problem`, { note: 'The inverter still trips every evening.' })).status, 409, 'once');
  assert.ok(mails.some((m) => m.includes(`PROBLEM REPORTED · ${R9}`)));
  await query("UPDATE repair_requests SET confirm_due_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE public_ref = ?", [R9]);
  await repairsService.housekeeping();
  assert.equal((await row(R9)).status, 'repair_done', 'a reported problem is never closed automatically');
  assert.equal((await admin('GET', '/admin/repairs?status=needs_action')).body.requests.some((r) => r.ref === R9), true);
  assert.equal((await buyer('POST', `/admin/repairs/${R9}/confirm`)).status, 403);
  assert.equal((await admin('POST', `/admin/repairs/${R9}/confirm`)).status, 200);
  assert.equal((await row(R9)).status, 'completed');
  // admin cancels a paid repair: everything paid goes back, no payout
  const R10 = await quick(30000);
  const a10 = await buyer('POST', `/repairs/${R10}/approve-quote`);
  await buyer('POST', '/repairs/mock-pay', { reference: a10.body.reference });
  await T1.api('POST', `/installer/repairs/${R10}/start`);
  assert.equal((await buyer('POST', `/repairs/${R10}/cancel`)).status, 409, 'once the repair has started the customer cannot cancel here');
  assert.equal((await admin('POST', `/admin/repairs/${R10}/cancel`, { reason: 'Dispute settled: refund in full' })).status, 200);
  const x10 = await row(R10);
  assert.deepEqual([x10.status, Number(x10.refund_amount), Number(x10.refund_needed), Number(x10.payout_amount)], ['cancelled', 30000, 1, 0], 'the whole ₦30,000 paid is refunded');
  step('a reported problem blocks the automatic close and reaches the admin, who closes it; an admin cancel mid-repair refunds everything paid');

  // declining the estimate, cancelling after approval, no-shows
  const R11 = await quick(20000);
  assert.equal((await cust3('POST', `/repairs/${R11}/decline-quote`)).status, 404);
  assert.equal((await buyer('POST', `/repairs/${R11}/decline-quote`)).status, 200);
  const d11 = await row(R11);
  assert.deepEqual([d11.status, Number(d11.refund_amount), Number(d11.payout_amount), d11.payout_status], ['cancelled', 0, 4000, 'owed'], 'the visit is kept: nothing refunded, the technician earns their share of the call-out fee');
  const R12 = await quick(20000);
  const a12 = await buyer('POST', `/repairs/${R12}/approve-quote`);
  await buyer('POST', '/repairs/mock-pay', { reference: a12.body.reference });
  const x12 = await buyer('POST', `/repairs/${R12}/cancel`);
  assert.deepEqual([x12.status, x12.body.refund], [200, 15000], 'cancelled before the repair started: only the repair payment comes back');
  const c12 = await row(R12);
  assert.deepEqual([Number(c12.payout_amount), c12.payout_status], [4000, 'owed']);
  const R13 = await toAssigned();
  await T1.api('POST', `/installer/repairs/${R13}/on-my-way`);
  assert.equal((await buyer('POST', `/repairs/${R13}/no-show`)).status, 409, 'too early to call it a no-show');
  assert.equal((await cust3('POST', `/repairs/${R13}/no-show`)).status, 404);
  await query('UPDATE repair_requests SET on_the_way_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 HOUR) WHERE public_ref = ?', [R13]);
  const ns = await buyer('POST', `/repairs/${R13}/no-show`);
  assert.deepEqual([ns.status, ns.body.refund], [200, 5000], 'a no-show refunds the whole call-out fee');
  assert.equal((await buyer('POST', `/repairs/${R13}/no-show`)).status, 409);
  assert.ok(mails.some((m) => m.includes(`REFUND NEEDED · ${R13}`)));
  step('declining the estimate keeps the visit fee (technician paid); cancelling after approval refunds the repair payment; a no-show refunds in full');
}

server.close();
await pool.end();
realLog('\nAll end-to-end checks passed.');
