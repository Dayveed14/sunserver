// Security checks against a REAL database. Run after `npm run db:init`:   npm run e2e:security
// It covers: who can call which endpoint (every route, no login, wrong role, someone else's data),
// session tokens, cookie flags, login lock-out, OTP and password-reset rules, and Paystack webhook/verify safety.
// It creates throw-away accounts (sec-*@example.test). Use a development database.
process.env.JWT_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-1234';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_security_suite_secret';
process.env.NODE_ENV = 'development';
process.env.TRUST_PROXY = '1'; // lets each test client look like its own visitor, so the rate limits don't get in the way
process.env.LOGISTICS_EMAIL = 'rider@example.test';
process.env.ADMIN_NOTIFY_EMAIL = 'admin@example.test';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Paystack is faked in this process only: "initialize" always works, and "verify" says whatever `truth` says.
const truth = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.paystack.co/transaction/initialize')) return new Response(JSON.stringify({ status: true, data: { authorization_url: 'https://checkout.paystack.test/pay', access_code: 'ac_test' } }), { status: 200 });
  const m = u.match(/^https:\/\/api\.paystack\.co\/transaction\/verify\/(.+)$/);
  if (m) { const ref = decodeURIComponent(m[1]); const t = truth.get(ref); return new Response(JSON.stringify(t ? { status: true, data: { reference: ref, ...t } } : { status: false, message: 'Transaction reference not found.' }), { status: t ? 200 : 404 }); }
  return realFetch(url, init);
};

const mails = [];
const realLog = console.log;
console.log = (...a) => { const s = a.join(' '); mails.push(s); if (!s.startsWith('[mail:dev]')) realLog(...a); };

const { createApp } = await import('../src/app.js');
const { query, pool } = await import('../src/db/pool.js');
const { env } = await import('../src/config/env.js');

const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/api`;

let ipSeq = 10;
function client() {
  let cookie = '';
  const ip = `10.9.${Math.floor(ipSeq / 250)}.${ipSeq++ % 250}`;
  const call = async (method, p, body, headers = {}, raw) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'X-Forwarded-For': ip, ...(raw ? { 'Content-Type': raw.type } : body !== undefined && body !== null ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: raw ? raw.data : body !== undefined && body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) cookie = c.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, headers: res.headers, setCookie: set };
  };
  call.cookie = () => cookie;
  call.setCookie = (c) => { cookie = c; };
  return call;
}
const step = (m) => realLog(`✓ ${m}`);
const codeFor = (email) => [...mails].reverse().find((m) => m.includes(`Verification code for ${email}`)).match(/: (\d{6})$/)[1];
const resetLinkFor = (email) => [...mails].reverse().find((m) => m.includes(`Password reset link for ${email}`)).split(': ').slice(1).join(': ');

const PW = 'Passw0rd!long';
async function signUp(role, name, email, extra = {}) {
  const api = client();
  const reg = await api('POST', '/auth/register', {
    role, fullName: name, email, phone: '08031234567', password: PW,
    address: { line: '12 Test Street', state: 'lagos', areaId: extra.areaId ?? 'ikeja' }, ...(role !== 'individual' ? { companyName: `${name} Ltd` } : {}),
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const ver = await api('POST', '/auth/verify-otp', { email, role, code: codeFor(email) });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return api;
}

const stamp = Date.now();
const mail = (n) => `sec-${n}-${stamp}@example.test`;
const vendorA = await signUp('vendor', 'Vendor A', mail('va'));
const vendorB = await signUp('vendor', 'Vendor B', mail('vb'));
const custA = await signUp('individual', 'Customer A', mail('ca'), { areaId: 'yaba' });
const custB = await signUp('individual', 'Customer B', mail('cb'), { areaId: 'yaba' });
await query(`INSERT INTO users (email, password_hash, role, full_name, email_verified_at) VALUES (?, ?, 'admin', 'Sec Admin', UTC_TIMESTAMP())`, [mail('ad'), await bcrypt.hash(PW, 4)]);
const admin = client();
assert.equal((await admin('POST', '/auth/login', { email: mail('ad'), password: PW })).status, 200);
const anon = client();
step('test accounts: two vendors, two customers, one admin');

// ---------------------------------------------------------------------------------------------------------------
// 1. EVERY ROUTE. The route files are read from disk, so a new endpoint is checked automatically.
//    Anything not on the public list must refuse a visitor with no login (401).
// ---------------------------------------------------------------------------------------------------------------
const MOUNTS = {
  'auth.routes.js': { router: '/api/auth' }, 'analysis.routes.js': { router: '/api/analysis' }, 'vendorFee.routes.js': { router: '/api/vendor/fee' },
  'vendorOrders.routes.js': { router: '/api/vendor/orders' }, 'vendor.routes.js': { router: '/api/vendor' }, 'adminOrders.routes.js': { router: '/api/admin/orders' },
  'admin.routes.js': { router: '/api/admin' }, 'dispatch.routes.js': { router: '/api/dispatch' }, 'orders.routes.js': { router: '/api' },
  'offers.routes.js': { router: '/api/offers' }, 'shop.routes.js': { router: '/api/shop' }, 'webhook.routes.js': { router: '/api/webhooks' },
  'images.routes.js': { vendorUploadRouter: '/api/vendor/images', adminUploadRouter: '/api/admin/images', viewRouter: '/api/images' },
};
const PUBLIC = new Set([
  'POST /auth/register', 'POST /auth/verify-otp', 'POST /auth/resend-otp', 'POST /auth/login', 'POST /auth/forgot-password', 'POST /auth/reset-password', 'POST /auth/logout', 'GET /auth/areas',
  'GET /analysis/catalog/:segment', 'POST /analysis/estimate',
  'GET /dispatch/info', 'POST /dispatch/confirm', // protected by a signed link, tested below
  'GET /shop/products', 'GET /shop/deals', 'GET /shop/products/:id', 'GET /shop/deals/:id',
  'GET /images/:id', 'POST /webhooks/paystack', // the webhook is protected by its signature, tested below
]);
const routeDir = path.resolve('src/routes');
const found = [];
for (const [file, mounts] of Object.entries(MOUNTS)) {
  const src = fs.readFileSync(path.join(routeDir, file), 'utf8');
  for (const m of src.matchAll(/(\w+)\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
    const prefix = mounts.router ?? mounts[m[1]];
    if (prefix === undefined) continue;
    const full = (prefix + (m[3] === '/' ? '' : m[3])).replace(/^\/api/, '') || '/';
    found.push({ method: m[2].toUpperCase(), full, key: `${m[2].toUpperCase()} ${full}` });
  }
}
assert.ok(found.length > 60, `expected to find the API routes, found ${found.length}`);
const unknownPublic = [...PUBLIC].filter((k) => !found.some((f) => f.key === k));
assert.deepEqual(unknownPublic, [], `public list names routes that do not exist: ${unknownPublic}`);
const sample = (full) => full.replace(/:\w+/g, '1');
let checked = 0;
for (const r of found.filter((f) => !PUBLIC.has(f.key))) {
  const res = await anon(r.method, sample(r.full), ['GET', 'DELETE'].includes(r.method) ? undefined : {});
  assert.equal(res.status, 401, `${r.key} answered ${res.status} to a visitor who is not logged in`);
  checked++;
}
step(`${checked} protected endpoints all refuse a visitor with no login (${found.length - checked} are public on purpose)`);

// ---------------------------------------------------------------------------------------------------------------
// 2. WRONG ROLE. Each kind of account against the other kinds' areas.
// ---------------------------------------------------------------------------------------------------------------
const roleOf = (full) => (full.startsWith('/admin') ? 'admin' : full.startsWith('/vendor') ? 'vendor'
  : /^\/(offers|checkout|orders|analysis\/assessments)/.test(full) ? 'customer' : null);
const actors = { admin, vendor: vendorA, customer: custA };
let crossed = 0;
for (const r of found.filter((f) => !PUBLIC.has(f.key))) {
  const need = roleOf(r.full);
  if (!need) continue; // /auth/me etc. are for any logged-in account
  for (const [who, api] of Object.entries(actors)) {
    if (who === need) continue;
    const res = await api(r.method, sample(r.full), ['GET', 'DELETE'].includes(r.method) ? undefined : {});
    assert.equal(res.status, 403, `${r.key} let a ${who} account in (answered ${res.status})`);
    crossed++;
  }
}
step(`${crossed} wrong-account-type calls (customer on vendor/admin, vendor on admin/customer, admin on vendor/customer) were all refused with 403`);

// ---------------------------------------------------------------------------------------------------------------
// 3. SOMEONE ELSE'S DATA. Vendor B and Customer B try to touch what belongs to A.
// ---------------------------------------------------------------------------------------------------------------
const mk = async (api, cat, name, rating, volt, price) => {
  const r = await api('POST', '/vendor/products', { category: cat, name, rating, systemVoltage: volt, price, inStock: true, status: 'active', ...(cat === 'battery' ? { batteryType: 'lithium' } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.product.id;
};
const panelA = await mk(vendorA, 'panel', 'A panel 550W', 550, null, 100000);
const invA = await mk(vendorA, 'inverter', 'A inverter 5kVA', 5, 48, 400000);
const batA = await mk(vendorA, 'battery', 'A battery 48V', 5, 48, 600000);
const dealRes = await vendorA('POST', '/vendor/deals', { title: 'A starter', items: [{ productId: panelA, qty: 6 }, { productId: invA, qty: 1 }, { productId: batA, qty: 1 }], installationIncluded: true, buyPrice: 1500000, lease: { depositPct: 30, tenors: [3, 6, 12] }, status: 'active' });
assert.equal(dealRes.status, 201, JSON.stringify(dealRes.body));
const dealA = dealRes.body.deal.id;

const edit = { category: 'panel', name: 'HIJACKED', rating: 550, price: 1000, inStock: true, status: 'active' };
const notMine = (res, what) => assert.ok([403, 404].includes(res.status), `${what}: expected 403/404, got ${res.status} ${JSON.stringify(res.body)}`);
notMine(await vendorB('PUT', `/vendor/products/${panelA}`, edit), 'vendor B edits A product');
notMine(await vendorB('DELETE', `/vendor/products/${panelA}`), 'vendor B archives A product');
notMine(await vendorB('PUT', `/vendor/deals/${dealA}`, { title: 'HIJACK', items: [{ productId: panelA, qty: 1 }, { productId: invA, qty: 1 }, { productId: batA, qty: 1 }], installationIncluded: true, buyPrice: 1500000, status: 'active' }), 'vendor B edits A deal');
notMine(await vendorB('PATCH', `/vendor/deals/${dealA}/status`, { status: 'paused' }), 'vendor B pauses A deal');
notMine(await vendorB('DELETE', `/vendor/deals/${dealA}`), 'vendor B archives A deal');
const [pRow] = await query('SELECT name, price, status FROM products WHERE id = ?', [panelA]);
assert.equal(pRow.name, 'A panel 550W');
assert.equal(Number(pRow.price), 100000);
assert.equal(pRow.status, 'active');
assert.equal(((await vendorB('GET', '/vendor/products')).body.products ?? []).some((p) => p.id === panelA), false);
// vendor B cannot sneak A's products into B's own deal
const sneaky = await vendorB('POST', '/vendor/deals', { title: 'Stolen stock', items: [{ productId: panelA, qty: 6 }, { productId: invA, qty: 1 }, { productId: batA, qty: 1 }], installationIncluded: true, buyPrice: 1500000, status: 'active' });
assert.ok(sneaky.status >= 400 && sneaky.status < 500, `a vendor put another vendor's products in their deal (${sneaky.status})`);
step("vendor B cannot edit, archive, pause or re-use vendor A's products and deals, and A's data is unchanged");

// customer A buys; customer B tries to read / confirm A's order
const co = await custA('POST', '/checkout', { items: [{ kind: 'product', id: panelA, qty: 1 }] }, { 'Idempotency-Key': crypto.randomBytes(12).toString('hex') });
assert.ok([200, 201].includes(co.status), JSON.stringify(co.body));
const ref = co.body.order.ref;
notMine(await custB('GET', `/orders/${ref}`), 'customer B reads A order');
assert.equal(((await custB('GET', '/orders')).body.orders ?? []).some((o) => o.ref === ref), false);
notMine(await custB('POST', `/checkout/${ref}/pay`, {}), 'customer B re-pays A order');
notMine(await custB('POST', `/orders/${ref}/received/1`, {}), 'customer B confirms A delivery');
assert.equal((await custA('GET', `/orders/${ref}`)).status, 200);
step("customer B cannot see, pay for or confirm customer A's order");

// vendor B cannot act on A's orders; admin order actions closed to vendors (above); a vendor never sees other vendors' orders
const [{ id: voId }] = await query('SELECT vo.id FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id WHERE o.public_ref = ?', [ref]);
notMine(await vendorB('POST', `/vendor/orders/${voId}/accept`, {}), 'vendor B accepts A order');
assert.equal(((await vendorB('GET', '/vendor/orders')).body.orders ?? []).length, 0);
step("vendor B cannot see or act on vendor A's orders");

// assessments
const est = { segment: 'home', disco: 'aedc', supplyBand: 'C', items: [{ applianceId: 'led-bulb', variantId: 'small', qty: 4, hoursKey: 'h4' }] };
const saved = await custA('POST', '/analysis/assessments', est);
assert.ok([200, 201].includes(saved.status), JSON.stringify(saved.body));
const aid = saved.body.id ?? saved.body.assessment?.id;
assert.ok(aid, JSON.stringify(saved.body));
notMine(await custB('GET', `/analysis/assessments/${aid}`), 'customer B reads A assessment');
notMine(await custB('GET', `/offers/assessments/${aid}`), 'customer B reads A offers');
notMine(await custB('POST', `/offers/assessments/${aid}/requests`, { kind: 'deal', dealId: dealA, plan: 'buy' }), 'customer B sends a request from A assessment');
assert.equal(((await custB('GET', '/analysis/assessments')).body.assessments ?? []).some((a) => a.id === aid), false);
step("customer B cannot read A's saved assessments or send requests from them");

// ---------------------------------------------------------------------------------------------------------------
// 4. SESSIONS AND COOKIES
// ---------------------------------------------------------------------------------------------------------------
const login = client();
const li = await login('POST', '/auth/login', { email: mail('ca'), password: PW });
assert.equal(li.status, 200);
const sc = li.setCookie.find((c) => c.startsWith('sl_session='));
assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Lax/i); assert.match(sc, /Path=\//i); assert.match(sc, /Max-Age=\d+/i);
assert.doesNotMatch(li.body ? JSON.stringify(li.body) : '', /password|hash|token_version/i);
step('session cookie is HttpOnly, SameSite=Lax, has an expiry; login response leaks no hash or token version');

// production cookies must be Secure: check in a fresh process with NODE_ENV=production
const { spawnSync } = await import('node:child_process');
const prodCheck = spawnSync(process.execPath, ['-e', `
  process.env.NODE_ENV='production'; process.env.CLIENT_ORIGIN='https://solalium.example'; process.env.JWT_SECRET='x'.repeat(40); process.env.PAYSTACK_SECRET_KEY='sk_test_x';
  const { setSessionCookie } = await import('./src/lib/tokens.js');
  let header=''; setSessionCookie({ cookie:(n,v,o)=>{header=JSON.stringify(o)} }, { id:1, role:'individual', token_version:0 });
  console.log(header);`], { cwd: path.resolve('.'), encoding: 'utf8', input: '' });
assert.match(prodCheck.stdout, /"secure":true/, prodCheck.stdout + prodCheck.stderr);
step('in production the session cookie is Secure');

const good = li.setCookie[0].split(';')[0].split('=')[1];
const tryToken = async (token) => { const c = client(); c.setCookie(`sl_session=${token}`); return (await c('GET', '/auth/me')).status; };
assert.equal(await tryToken(good), 200);
assert.equal(await tryToken(good.slice(0, -2) + 'xx'), 401);
const claims = jwt.decode(good);
assert.equal(await tryToken(jwt.sign({ role: 'admin', tv: claims.tv }, env.jwtSecret, { algorithm: 'HS256', issuer: 'solalium', subject: String(claims.sub), expiresIn: '1h' })), 200, 'role in the token is ignored; the database role decides');
const meAs = await (async () => { const c = client(); c.setCookie(`sl_session=${jwt.sign({ role: 'admin', tv: claims.tv }, env.jwtSecret, { algorithm: 'HS256', issuer: 'solalium', subject: String(claims.sub), expiresIn: '1h' })}`); return c('GET', '/admin/summary'); })();
assert.equal(meAs.status, 403, 'a forged role claim must not open admin routes');
assert.equal(await tryToken(jwt.sign({ tv: claims.tv }, 'wrong-secret-wrong-secret-wrong-secret', { algorithm: 'HS256', issuer: 'solalium', subject: String(claims.sub) })), 401);
assert.equal(await tryToken(jwt.sign({ tv: claims.tv }, env.jwtSecret, { algorithm: 'HS256', issuer: 'someone-else', subject: String(claims.sub) })), 401);
assert.equal(await tryToken(jwt.sign({ tv: claims.tv }, env.jwtSecret, { algorithm: 'HS256', issuer: 'solalium', subject: String(claims.sub), expiresIn: -10 })), 401);
const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: String(claims.sub), tv: claims.tv, iss: 'solalium' })).toString('base64url')}.`;
assert.equal(await tryToken(none), 401);
assert.equal(await tryToken(jwt.sign({ tv: claims.tv + 1 }, env.jwtSecret, { algorithm: 'HS256', issuer: 'solalium', subject: String(claims.sub) })), 401);
step('tampered, forged-secret, wrong-issuer, expired, alg:none and wrong-version tokens are all refused; a forged "admin" claim does nothing');

// suspension and password reset end existing sessions at once
const victimEmail = mail('cs');
const victim = await signUp('individual', 'Victim', victimEmail);
assert.equal((await victim('GET', '/auth/me')).status, 200);
const [{ id: victimId }] = await query('SELECT id FROM users WHERE email = ?', [victimEmail]);
const sus = await admin('PATCH', `/admin/users/${victimId}/status`, { status: 'suspended' });
assert.equal(sus.status, 200, JSON.stringify(sus.body));
assert.equal((await victim('GET', '/auth/me')).status, 401);
assert.equal((await client()('POST', '/auth/login', { email: victimEmail, password: PW })).status >= 400, true);
await admin('PATCH', `/admin/users/${victimId}/status`, { status: 'active' });
step('suspending an account ends its session immediately and blocks login');

const resetEmail = mail('cr');
const resetter = await signUp('individual', 'Resetter', resetEmail);
const stale = resetter.cookie();
const fg1 = await client()('POST', '/auth/forgot-password', { email: resetEmail });
const fg2 = await client()('POST', '/auth/forgot-password', { email: `nobody-${stamp}@example.test` });
assert.equal(fg1.status, fg2.status);
assert.deepEqual(fg1.body, fg2.body);
const link = resetLinkFor(resetEmail);
const token = new URL(link).searchParams.get('token');
assert.ok(token && token.length >= 32);
const [{ n }] = await query('SELECT COUNT(*) n FROM password_resets WHERE token_hash = ?', [token]);
assert.equal(Number(n), 0, 'the reset token must be stored hashed, not as sent');
assert.equal((await client()('POST', '/auth/reset-password', { token: 'not-a-real-token-not-a-real-token-1234', password: 'N3w-password-long' })).status >= 400, true);
assert.equal((await client()('POST', '/auth/reset-password', { token, password: 'short' })).status, 400);
const rs = await client()('POST', '/auth/reset-password', { token, password: 'N3w-password-long' });
assert.equal(rs.status, 200, JSON.stringify(rs.body));
const again = await client()('POST', '/auth/reset-password', { token, password: 'An0ther-password-long' });
assert.ok(again.status >= 400, 'a reset link must work only once');
const oldSession = client(); oldSession.setCookie(stale);
assert.equal((await oldSession('GET', '/auth/me')).status, 401, 'a password reset must end older sessions');
assert.equal((await client()('POST', '/auth/login', { email: resetEmail, password: PW })).status >= 400, true);
assert.equal((await client()('POST', '/auth/login', { email: resetEmail, password: 'N3w-password-long' })).status, 200);
// an expired link
await client()('POST', '/auth/forgot-password', { email: resetEmail }); // may be inside the cooldown; handled below
await query('UPDATE password_resets SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE user_id = (SELECT id FROM users WHERE email = ?)', [resetEmail]);
const expLink = resetLinkFor(resetEmail);
assert.ok(new URL(expLink).searchParams.get('token'));
step('forgot-password answers the same for unknown emails; reset token is hashed, single-use, rejects weak passwords, and ends older sessions');

// login lock-out and same message for unknown user vs wrong password
const lockEmail = mail('cl');
await signUp('individual', 'Locker', lockEmail);
const wrong = await client()('POST', '/auth/login', { email: lockEmail, password: 'wrong-password-1' });
const unknown = await client()('POST', '/auth/login', { email: `ghost-${stamp}@example.test`, password: 'wrong-password-1' });
assert.equal(wrong.status, unknown.status);
assert.equal(wrong.body.error.message, unknown.body.error.message, 'unknown email and wrong password must read the same');
const attacker = client();
let lockedAt = 0;
for (let i = 1; i <= 8; i++) {
  const r = await attacker('POST', '/auth/login', { email: lockEmail, password: `wrong-password-${i}` });
  if (r.status === 429 || /locked|too many/i.test(JSON.stringify(r.body))) { lockedAt = i; break; }
}
assert.ok(lockedAt > 0 && lockedAt <= 7, `account never locked after repeated wrong passwords (${lockedAt})`);
assert.notEqual((await client()('POST', '/auth/login', { email: lockEmail, password: PW })).status, 200, 'the right password must not work while locked');
step(`login locks after ${lockedAt} wrong passwords, even for the right password; unknown email and wrong password look identical`);

// OTP: wrong codes run out, a used code is dead, resend cooldown
const otpEmail = mail('co');
const otpClient = client();
await otpClient('POST', '/auth/register', { role: 'individual', fullName: 'Otp Test', email: otpEmail, phone: '08031234567', password: PW, address: { line: '12 Test Street', state: 'lagos', areaId: 'ikeja' } });
const realCode = codeFor(otpEmail);
let blocked = false;
for (let i = 0; i < 8; i++) {
  const wrongCode = String((Number(realCode) + 1 + i) % 1000000).padStart(6, '0');
  const r = await otpClient('POST', '/auth/verify-otp', { email: otpEmail, role: 'individual', code: wrongCode === realCode ? '000000' : wrongCode });
  if (r.status === 429 || /too many|request a new/i.test(JSON.stringify(r.body))) { blocked = true; break; }
}
assert.ok(blocked, 'unlimited wrong OTP guesses were allowed');
assert.notEqual((await otpClient('POST', '/auth/verify-otp', { email: otpEmail, role: 'individual', code: realCode })).status, 200, 'the real code must not work after too many wrong guesses');
const rsend1 = await otpClient('POST', '/auth/resend-otp', { email: otpEmail, role: 'individual' });
const rsend2 = await otpClient('POST', '/auth/resend-otp', { email: otpEmail, role: 'individual' });
assert.ok(rsend2.status >= 400 || rsend1.status >= 400, 'resend has no cooldown');
const [{ code_hash }] = await query('SELECT code_hash FROM email_otps WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY id DESC LIMIT 1', [otpEmail]);
assert.notEqual(code_hash, realCode);
step('OTP: wrong guesses run out, the code is stored hashed, resend has a cooldown');

// ---------------------------------------------------------------------------------------------------------------
// 5. PAYSTACK: signatures, verification, duplicates, failures
// ---------------------------------------------------------------------------------------------------------------
const secret = process.env.PAYSTACK_SECRET_KEY;
const sign = (raw) => crypto.createHmac('sha512', secret).update(raw).digest('hex');
const [pay] = await query('SELECT p.reference, ROUND(p.amount * 100) AS amount_kobo FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_ref = ?', [ref]);
assert.ok(pay, 'the checkout should have created a payment row');
const event = (over = {}) => JSON.stringify({ event: 'charge.success', data: { reference: pay.reference, amount: Number(pay.amount_kobo), currency: 'NGN', status: 'success', ...over } });
const hook = (raw, sig) => anon('POST', '/webhooks/paystack', raw, { 'x-paystack-signature': sig ?? '' , 'Content-Type': 'application/json' });
const statusOf = async () => (await query('SELECT status FROM orders WHERE public_ref = ?', [ref]))[0].status;
const before = await statusOf();
assert.equal(before, 'pending_payment');
assert.equal((await hook(event(), undefined)).status >= 400, true, 'no signature');
assert.equal((await hook(event(), 'deadbeef')).status >= 400, true, 'bad signature');
assert.equal((await hook(event(), sign(event() + ' '))).status >= 400, true, 'signature for different bytes');
assert.equal(await statusOf(), 'pending_payment');
step('webhook with no, wrong, or other-bytes signature is refused and nothing changes');
const short = event({ amount: Number(pay.amount_kobo) - 100 });
await hook(short, sign(short));
assert.equal(await statusOf(), 'pending_payment', 'a short payment must not mark the order paid');
const wrongCur = event({ currency: 'USD' });
await hook(wrongCur, sign(wrongCur));
assert.equal(await statusOf(), 'pending_payment', 'wrong currency must not mark the order paid');
const failed = JSON.stringify({ event: 'charge.failed', data: { reference: pay.reference, amount: Number(pay.amount_kobo), currency: 'NGN', status: 'failed' } });
await hook(failed, sign(failed));
assert.equal(await statusOf(), 'pending_payment', 'a failed charge must not mark the order paid');
const unknownRef = event({ reference: 'no-such-reference' });
assert.ok((await hook(unknownRef, sign(unknownRef))).status < 500, 'unknown reference must not crash');
step('short payment, wrong currency, failed charge and unknown reference leave the order unpaid');
const good1 = event();
const results = await Promise.all(Array.from({ length: 6 }, () => hook(good1, sign(good1))));
assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
assert.equal(await statusOf(), 'paid');
const [{ c: payCount }] = await query("SELECT COUNT(*) c FROM payments WHERE reference = ? AND status = 'success'", [pay.reference]);
assert.equal(Number(payCount), 1);
const [{ c: vos }] = await query('SELECT COUNT(*) c FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id WHERE o.public_ref = ?', [ref]);
assert.equal(Number(vos), 1);
const replay = await hook(good1, sign(good1));
assert.equal(replay.status, 200);
assert.equal(Number((await query("SELECT COUNT(*) c FROM payments WHERE reference = ? AND status = 'success'", [pay.reference]))[0].c), 1);
step('6 simultaneous genuine webhooks plus a later replay: paid once, one vendor order, one success row');
const bodyless = await anon('POST', '/webhooks/paystack', '{not json', { 'x-paystack-signature': sign('{not json'), 'Content-Type': 'application/json' });
assert.ok(bodyless.status < 500, 'malformed webhook body must not crash the server');

// verify route (what the customer's browser triggers after paying): trusts Paystack's answer, not the browser's
const verifyOrder = async (api, label) => {
  const c = await api('POST', '/checkout', { items: [{ kind: 'product', id: panelA, qty: 1 }] }, { 'Idempotency-Key': crypto.randomBytes(12).toString('hex') });
  assert.ok([200, 201].includes(c.status), `${label}: ${JSON.stringify(c.body)}`);
  const [row] = await query('SELECT p.reference, ROUND(p.amount * 100) AS amount_kobo, o.public_ref FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_ref = ?', [c.body.order.ref]);
  return row;
};
const orderStatus = async (r) => (await query('SELECT status FROM orders WHERE public_ref = ?', [r]))[0].status;
const v1 = await verifyOrder(custA, 'verify order');
for (const [label, t] of Object.entries({
  'not found at Paystack': null,
  abandoned: { status: 'abandoned', amount: Number(v1.amount_kobo), currency: 'NGN' },
  failed: { status: 'failed', amount: Number(v1.amount_kobo), currency: 'NGN' },
  'short payment': { status: 'success', amount: Number(v1.amount_kobo) - 100, currency: 'NGN' },
  'wrong currency': { status: 'success', amount: Number(v1.amount_kobo), currency: 'USD' },
})) {
  if (t) truth.set(v1.reference, t); else truth.delete(v1.reference);
  await custA('POST', '/checkout/verify', { reference: v1.reference });
  assert.equal(await orderStatus(v1.public_ref), 'pending_payment', `verify with Paystack saying "${label}" must not mark the order paid`);
}
truth.set(v1.reference, { status: 'success', amount: Number(v1.amount_kobo), currency: 'NGN' });
const vCalls = await Promise.all([1, 2, 3, 4].map(() => custA('POST', '/checkout/verify', { reference: v1.reference })));
assert.ok(vCalls.every((r) => r.status === 200), JSON.stringify(vCalls.map((r) => r.body)));
assert.equal(await orderStatus(v1.public_ref), 'paid');
assert.equal(Number((await query("SELECT COUNT(*) c FROM payments WHERE reference = ? AND status = 'success'", [v1.reference]))[0].c), 1);
assert.equal(Number((await query('SELECT COUNT(*) c FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id WHERE o.public_ref = ?', [v1.public_ref]))[0].c), 1);
step('verify trusts Paystack only: not-found, abandoned, failed, short and wrong-currency answers leave the order unpaid; 4 simultaneous genuine verifies pay it once');

// the customer-facing verify route must not accept someone else's reference or invent one
const refB = await custB('POST', '/checkout/verify', { reference: pay.reference });
assert.ok(refB.status >= 400, "customer B verified customer A's payment reference");
assert.ok((await custA('POST', '/checkout/verify', { reference: 'made-up-reference-123' })).status >= 400);
const mockTry = await custA('POST', '/checkout/mock-pay', { reference: pay.reference });
assert.ok([400, 404].includes(mockTry.status), `simulated payment must be switched off when Paystack is configured (got ${mockTry.status})`);
assert.ok([400, 404].includes((await vendorA('POST', '/vendor/fee/mock-pay', { reference: 'x'.repeat(12) })).status));
step('verify refuses another customer\'s or invented references; simulated payment endpoints are off when Paystack is configured');

// ---------------------------------------------------------------------------------------------------------------
// 6. OTHER INPUT HARDENING
// ---------------------------------------------------------------------------------------------------------------
const big = await anon('POST', '/analysis/estimate', JSON.stringify({ x: 'a'.repeat(200 * 1024) }), { 'Content-Type': 'application/json' });
assert.ok([400, 413].includes(big.status), `oversized JSON answered ${big.status}`);
const sqli = await anon('GET', "/shop/products?state=lagos&q=' OR 1=1 --");
assert.ok(sqli.status === 200 && Array.isArray(sqli.body.products), 'search text must be treated as text');
const traversal = await anon('GET', '/images/..%2f..%2fetc%2fpasswd');
assert.ok([400, 404].includes(traversal.status));
const hdr = await anon('GET', '/health');
assert.equal(hdr.headers.get('x-powered-by'), null);
assert.ok(hdr.headers.get('x-content-type-options') && hdr.headers.get('strict-transport-security'));
const preflight = await fetch(base + '/auth/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
assert.notEqual(preflight.headers.get('access-control-allow-origin'), 'https://evil.example');
assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*');
const okPre = await fetch(base + '/auth/me', { method: 'OPTIONS', headers: { Origin: env.clientOrigin, 'Access-Control-Request-Method': 'GET' } });
assert.equal(okPre.headers.get('access-control-allow-origin'), env.clientOrigin);
assert.equal(okPre.headers.get('access-control-allow-credentials'), 'true');
step('oversized bodies, SQL-looking search text and path tricks are handled; security headers present; CORS allows only the configured site');

// ---------------------------------------------------------------------------------------------------------------
// 7. ORDER STATES with real transactions: simultaneous clicks, skipped steps, wrong people
// ---------------------------------------------------------------------------------------------------------------
const { createDispatchTokens } = await import('../src/lib/dispatchToken.js');
const tokens = createDispatchTokens(`${process.env.JWT_SECRET}:dispatch`);
const rider = client();
const voStatus = async () => (await query('SELECT status FROM vendor_orders WHERE id = ?', [voId]))[0].status;
const ok = (r) => r.status >= 200 && r.status < 300;
assert.equal(await voStatus(), 'placed');
// skipped / wrong-person steps change nothing
for (const a of ['prepare', 'ready']) assert.ok(!ok(await vendorA('POST', `/vendor/orders/${voId}/${a}`, {})), `${a} before accept`);
for (const a of ['pickup', 'deliver', 'receive']) assert.ok(!ok(await vendorA('POST', `/vendor/orders/${voId}/${a}`, {})), `vendor must not be able to ${a}`);
assert.ok(!ok(await custA('POST', `/orders/${ref}/received/${voId}`, {})), 'customer confirms before delivery');
assert.ok(!ok(await rider('POST', '/dispatch/confirm', { t: tokens.sign(voId, 'deliver') })), 'rider delivers before pickup');
assert.ok(!ok(await rider('POST', '/dispatch/confirm', { t: tokens.sign(voId, 'pickup') })), 'rider picks up before the vendor accepted');
assert.equal(await voStatus(), 'placed');
// five simultaneous accepts: one wins, the rest are harmless
const accepts = await Promise.all([1, 2, 3, 4, 5].map(() => vendorA('POST', `/vendor/orders/${voId}/accept`, {})));
assert.ok(accepts.filter(ok).length >= 1 && accepts.every((r) => r.status < 500), JSON.stringify(accepts.map((r) => r.status)));
assert.equal(await voStatus(), 'accepted');
const acceptMails = mails.filter((m) => m.includes(`Order ${ref}`) && /accepted/i.test(m) && m.includes('[mail:dev] To ' + mail('ca')));
assert.ok(acceptMails.length <= 1, `customer got ${acceptMails.length} "accepted" emails from simultaneous clicks`);
assert.ok(!ok(await vendorA('POST', `/vendor/orders/${voId}/reject`, {})), 'reject after accept');
await vendorA('POST', `/vendor/orders/${voId}/prepare`, {});
await vendorA('POST', `/vendor/orders/${voId}/ready`, {});
assert.equal(await voStatus(), 'ready_for_pickup');
const pickups = await Promise.all([1, 2, 3].map(() => rider('POST', '/dispatch/confirm', { t: tokens.sign(voId, 'pickup') })));
assert.ok(pickups.every((r) => r.status < 500));
assert.equal(await voStatus(), 'out_for_delivery');
assert.ok(!ok(await custA('POST', `/orders/${ref}/received/${voId}`, {})), 'customer confirms while still out for delivery');
await rider('POST', '/dispatch/confirm', { t: tokens.sign(voId, 'deliver') });
assert.equal(await voStatus(), 'delivered');
const recv = await Promise.all([1, 2, 3, 4].map(() => custA('POST', `/orders/${ref}/received/${voId}`, {})));
assert.ok(recv.every((r) => r.status < 500));
assert.equal(await voStatus(), 'completed');
assert.ok(!ok(await adminOrdersRefundTry()), 'a completed, un-rejected order must not be refundable');
async function adminOrdersRefundTry() { return admin('POST', `/admin/orders/${voId}/refunded`, {}); }
const stamps = (await query('SELECT accepted_at, picked_up_at, delivered_at, completed_at FROM vendor_orders WHERE id = ?', [voId]))[0];
assert.ok(stamps.accepted_at && stamps.picked_up_at && stamps.delivered_at && stamps.completed_at);
assert.ok(new Date(stamps.accepted_at) <= new Date(stamps.picked_up_at) && new Date(stamps.picked_up_at) <= new Date(stamps.delivered_at) && new Date(stamps.delivered_at) <= new Date(stamps.completed_at), 'timestamps out of order');
step('order states: skipped steps and wrong people change nothing; 5 simultaneous accepts, 3 pickups and 4 confirmations each count once; timestamps stay in order');

server.close();
await pool.end();
realLog('\nAll security checks passed.');
