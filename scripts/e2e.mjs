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
assert.ok(lagos.body.products.some((p) => p.id === pid && p.imageUrl));
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

  // installers: quiz, no score shown to them, admin decides
  const inst = await signUp('installer', 'Ife Installer', `e2e-inst-${stamp}@example.test`);
  const quiz = await inst('GET', '/installer/quiz');
  assert.equal(quiz.status, 200);
  assert.ok(quiz.body.questions.length >= 10);
  assert.ok(!JSON.stringify(quiz.body).includes('"correct"'), 'right answers never reach the installer');
  assert.equal((await inst('POST', '/installer/quiz', { answers: { isolate: 'b' } })).status, 400, 'every question must be answered');
  const answers = Object.fromEntries(quiz.body.questions.map((q) => [q.id, 'b']));
  const subQ = await inst('POST', '/installer/quiz', { answers, yearsExperience: 4 });
  assert.equal(subQ.status, 200, JSON.stringify(subQ.body));
  assert.deepEqual(Object.keys(subQ.body), ['submitted']);
  assert.ok(!JSON.stringify((await inst('GET', '/installer/summary')).body).match(/score/i), 'no score shown to the installer');
  assert.equal((await inst('POST', '/installer/quiz', { answers })).status, 409, 'cannot resubmit while waiting');
  const [iRow] = await query("SELECT id FROM users WHERE email = ? AND role = 'installer'", [`e2e-inst-${stamp}@example.test`]);
  const list = await admin('GET', '/admin/installers?status=pending');
  assert.ok(list.body.installers.some((i) => i.userId === Number(iRow.id) && i.total === quiz.body.questions.length));
  const detail = await admin('GET', `/admin/installers/${iRow.id}`);
  assert.ok(detail.body.quiz.score >= 10 && detail.body.quiz.detail.length === quiz.body.questions.length);
  assert.equal((await vendor('GET', `/admin/installers/${iRow.id}`)).status, 403);
  assert.equal((await admin('PATCH', `/admin/installers/${iRow.id}/verification`, { status: 'verified' })).status, 200);
  assert.equal((await inst('GET', '/installer/summary')).body.verification, 'verified');
  assert.equal((await buyer('GET', '/installer/quiz')).status, 403);
  step(`installer answered the quiz (score hidden from them, ${detail.body.quiz.score}/${detail.body.quiz.total} for the admin) and was approved`);
}

// ---------- installation requests: quote, pay, broadcast, first-accept, finish, confirm, payout ----------
{
  // Earlier test runs left approved installers behind; stand them down so only this run's installers are in play.
  await query("UPDATE installer_profiles ip JOIN users u ON u.id = ip.user_id SET ip.verification_status = 'pending' WHERE u.email LIKE 'e2e-%@example.test'");
  const mk = async (name, key, extra = {}) => {
    const email = `e2e-${key}-${stamp}@example.test`;
    const api = await signUp('installer', name, email, extra);
    const [row] = await query("SELECT id FROM users WHERE email = ? AND role = 'installer'", [email]);
    if (!extra.unverified) await query("UPDATE installer_profiles SET verification_status = 'verified', quiz_submitted_at = UTC_TIMESTAMP() WHERE user_id = ?", [row.id]);
    return { api, id: Number(row.id), email };
  };
  const instA = await mk('Ade Installer', 'ia');
  const instB = await mk('Bayo Installer', 'ib');
  const instAbuja = await mk('Abuja Installer', 'iab', { state: 'abuja', areaId: 'wuse' });
  const instNew = await mk('New Installer', 'inew', { unverified: true });
  const cust2 = await signUp('individual', 'Other Customer', `e2e-cust2-${stamp}@example.test`, { areaId: 'yaba' });

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

  // the admin changes a band price: the next quote uses it, the old one is fixed
  assert.equal((await admin('PUT', '/admin/settings', { changes: { installPriceB3: 120000 } })).status, 200);
  const made2 = await buyer('POST', '/installations', body);
  assert.equal(made2.body.request.price, 120000);
  assert.equal((await buyer('GET', `/installations/${ref}`)).body.request.price, 110000, 'a quote keeps the price it was given');
  assert.equal((await admin('PUT', '/admin/settings', { changes: { installPriceB3: null } })).status, 200);
  assert.equal((await buyer('POST', `/installations/${made2.body.request.ref}/cancel`)).status, 200, 'an unpaid request can be cancelled');
  step('admin band price change applies to new quotes only');

  // pay: four taps, one payment
  const taps = await Promise.all([1, 2, 3, 4].map(() => buyer('POST', `/installations/${ref}/pay`)));
  assert.ok(taps.every((t) => t.status === 201), JSON.stringify(taps.map((t) => t.body)));
  assert.equal(new Set(taps.map((t) => t.body.reference)).size, 1);
  const payRef = taps[0].body.reference;
  assert.ok(payRef.startsWith('IP-'));
  assert.equal((await cust2('POST', `/installations/mock-pay`, { reference: payRef })).status, 404);
  const paid = await Promise.all([1, 2, 3, 4, 5, 6].map(() => buyer('POST', `/installations/mock-pay`, { reference: payRef })));
  assert.ok(paid.every((p) => p.status === 200 && p.body.status === 'paid'), JSON.stringify(paid.map((p) => p.body)));
  const [{ n: offerCount }] = await query('SELECT COUNT(*) AS n FROM install_offers o JOIN install_requests r ON r.id = o.request_id WHERE r.public_ref = ?', [ref]);
  assert.equal(Number(offerCount), 2, 'sent once to each approved Lagos installer, however many payment reports arrived');
  assert.equal(mails.filter((m) => m.includes('New installation job')).length >= 2, true);
  step('4 taps = 1 payment; 6 simultaneous confirmations opened the job once and sent it to the 2 approved Lagos installers');

  // what an installer sees before accepting: no address, no customer phone
  const seen = await instA.api('GET', '/installer/jobs');
  assert.equal(seen.body.jobs.length, 1);
  const seenText = JSON.stringify(seen.body);
  assert.ok(!seenText.includes('Secret Close') && !seenText.includes('contact') && !seenText.includes('+234'), 'address and phone are hidden before accepting');
  assert.equal(seen.body.jobs[0].pay, 77000);
  assert.deepEqual((await instAbuja.api('GET', '/installer/jobs')).body.jobs, [], 'installers in another state are not sent the job');
  assert.equal((await instNew.api('GET', '/installer/jobs')).status, 403, 'an unapproved installer gets no jobs');
  assert.equal((await instAbuja.api('POST', `/installer/jobs/${ref}/accept`, { confirmAvailable: true })).status, 404);
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/accept`, {})).status, 400);
  assert.equal((await instA.api('POST', `/installer/jobs/${ref}/accept`, { confirmAvailable: false })).status, 400, 'availability must be confirmed');
  step('installers see the job and pay but not the address; other states and unapproved installers see nothing');

  // two installers race: exactly one wins
  const race = await Promise.all([
    instA.api('POST', `/installer/jobs/${ref}/accept`, { confirmAvailable: true }),
    instB.api('POST', `/installer/jobs/${ref}/accept`, { confirmAvailable: true }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const winner = race.find((r) => r.status === 200);
  const winnerApi = race[0].status === 200 ? instA.api : instB.api;
  const loserApi = race[0].status === 200 ? instB.api : instA.api;
  assert.ok(winner.body.job.address.includes('Secret Close'), 'the winner gets the address');
  assert.equal(winner.body.job.customer.phone.startsWith('+234'), true);
  assert.deepEqual((await loserApi('GET', '/installer/jobs')).body.jobs, [], 'the job disappears for the installer who lost');
  assert.equal((await loserApi('GET', `/installer/jobs/${ref}`)).status, 404);
  const cview = await buyer('GET', `/installations/${ref}`);
  assert.equal(cview.body.request.status, 'assigned');
  assert.ok(cview.body.request.installer?.phone, 'the customer now sees the installer');
  assert.ok(mails.some((m) => m.includes('You got the job')) && mails.some((m) => m.includes('An installer accepted')));
  step('two installers accepted at once: one won (and got the address), one was told it was taken');

  // finish
  assert.equal((await buyer('POST', `/installations/${ref}/confirm`)).status, 409, 'cannot confirm before the installer is done');
  assert.equal((await loserApi('POST', `/installer/jobs/${ref}/done`)).status, 404);
  assert.equal((await winnerApi('POST', `/installer/jobs/${ref}/done`)).status, 200);
  assert.equal((await winnerApi('POST', `/installer/jobs/${ref}/done`)).status, 200, 'marking done twice is harmless');
  assert.equal((await cust2('POST', `/installations/${ref}/confirm`)).status, 404);
  const conf = await Promise.all([1, 2, 3].map(() => buyer('POST', `/installations/${ref}/confirm`)));
  assert.ok(conf.every((c) => c.status === 200));
  assert.equal(mails.filter((m) => m.includes(`PAYOUT OWED · ${ref}`)).length, 1, 'three confirmations closed it once');
  const earned = await winnerApi('GET', '/installer/jobs/mine');
  assert.equal(earned.body.earnings.owed, 77000);
  assert.equal((await admin('POST', `/admin/installations/${ref}/payout-paid`)).status, 200);
  assert.equal((await admin('POST', `/admin/installations/${ref}/payout-paid`)).status, 409, 'a payout is recorded once');
  assert.equal((await winnerApi('GET', '/installer/jobs/mine')).body.earnings.paid, 77000);
  step('done → confirmed once → payout ₦77,000 owed, then recorded as paid once');

  const newPaidJob = async (extraBody = {}) => {
    const m = await buyer('POST', '/installations', { ...body, ...extraBody });
    const p = await buyer('POST', `/installations/${m.body.request.ref}/pay`);
    await buyer('POST', "/installations/mock-pay", { reference: p.body.reference });
    return m.body.request.ref;
  };

  // 12-hour auto close
  const r2 = await newPaidJob();
  await instA.api('POST', `/installer/jobs/${r2}/accept`, { confirmAvailable: true });
  await instB.api('POST', `/installer/jobs/${r2}/accept`, { confirmAvailable: true });
  const [r2row] = await query('SELECT installer_id FROM install_requests WHERE public_ref = ?', [r2]);
  const r2api = Number(r2row.installer_id) === instA.id ? instA.api : instB.api;
  await r2api('POST', `/installer/jobs/${r2}/done`);
  await query("UPDATE install_requests SET installer_done_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 11 HOUR) WHERE public_ref = ?", [r2]);
  await installationsService.housekeeping();
  assert.equal((await buyer('GET', `/installations/${r2}`)).body.request.status, 'installer_done', 'not closed before 12 hours');
  await query("UPDATE install_requests SET installer_done_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 13 HOUR) WHERE public_ref = ?", [r2]);
  await Promise.all([installationsService.housekeeping(), installationsService.housekeeping()]);
  assert.equal((await buyer('GET', `/installations/${r2}`)).body.request.status, 'completed');
  assert.equal(mails.filter((m) => m.includes(`PAYOUT OWED · ${r2}`)).length, 1);
  step('a finished job nobody confirmed closed itself after 12 hours (not at 11), once');

  // nobody accepts → admin alert; decline → still offered to the other; all decline → alert
  const r3 = await newPaidJob();
  await query("UPDATE install_requests SET open_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR) WHERE public_ref = ?", [r3]);
  const hk = await installationsService.housekeeping();
  assert.ok(hk.alerted >= 1);
  assert.ok(mails.some((m) => m.includes(`NO INSTALLER YET · ${r3}`) && m.includes('Nobody has accepted')));
  const again = await installationsService.housekeeping();
  assert.equal(again.alerted, 0, 'the alert is sent once');
  const r4 = await newPaidJob();
  assert.equal((await instA.api('POST', `/installer/jobs/${r4}/decline`)).status, 200);
  assert.equal((await instB.api('GET', '/installer/jobs')).body.jobs.some((j) => j.ref === r4), true, 'the other installer still has the job');
  assert.equal((await instA.api('GET', '/installer/jobs')).body.jobs.some((j) => j.ref === r4), false);
  assert.equal((await instB.api('POST', `/installer/jobs/${r4}/decline`)).status, 200);
  assert.ok(mails.some((m) => m.includes(`NO INSTALLER YET · ${r4}`) && m.includes('declined')));
  step('no taker after 2 hours alerts the admin once; a decline passes the job to the others; everyone declining alerts the admin');

  // admin cancels a stuck paid job: refund flagged; customer cannot cancel a paid job
  assert.equal((await buyer('POST', `/installations/${r4}/cancel`)).status, 409);
  assert.equal((await admin('POST', `/admin/installations/${r4}/cancel`, {})).status, 400, 'a reason is required');
  assert.equal((await admin('POST', `/admin/installations/${r4}/cancel`, { reason: 'No installer available' })).status, 200);
  assert.ok(mails.some((m) => m.includes(`REFUND NEEDED · ${r4}`)));
  assert.equal((await admin('GET', `/admin/installations?status=cancelled`)).body.requests.find((x) => x.ref === r4).refundNeeded, true);
  assert.equal((await admin('POST', `/admin/installations/${r4}/refunded`)).status, 200);
  assert.equal((await instB.api('POST', `/installer/jobs/${r4}/accept`, { confirmAvailable: true })).status, 409, 'a cancelled job cannot be taken');
  step('admin cancelled a stuck paid job; refund flagged then recorded; the job can no longer be taken');

  // jobs follow the customer's state
  const r5 = await newPaidJob({ state: 'abuja', areaId: 'garki' });
  assert.equal((await instAbuja.api('GET', '/installer/jobs')).body.jobs.some((j) => j.ref === r5), true, 'the Abuja installer was sent the Abuja job');
  const list = await admin('GET', '/admin/installations');
  assert.ok(list.body.requests.length >= 4 && list.body.stats);
  assert.equal((await buyer('GET', '/admin/installations')).status, 403);
  step('Abuja jobs go to Abuja installers; admin list and stats work');
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

server.close();
await pool.end();
realLog('\nAll end-to-end checks passed.');
