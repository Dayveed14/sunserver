import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { createWebhookHandler } from '../src/controllers/webhook.controller.js';
import { createHarness } from '../test-support/ordersHarness.js';

const sign = (body, secret) => crypto.createHmac('sha512', secret).update(body).digest('hex');

describe('Paystack webhook endpoint', () => {
  const h = createHarness();
  let server;
  let base;
  const SECRET = 'sk_test_webhook_secret';
  before(async () => {
    const app = express();
    app.post('/hook', express.raw({ type: '*/*', limit: '200kb' }), createWebhookHandler({ service: h.service, secretKey: SECRET }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const post = (body, sig) => fetch(`${base}/hook`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-paystack-signature': sig } : {}) }, body });

  const start = async () => {
    const co = await h.service.checkout({ id: 1, role: 'individual', email: 'c1@x.ng', fullName: 'Chi One' }, { items: [{ kind: 'product', id: 1, qty: 1 }], destination: h.dest, idempotencyKey: h.key() });
    return co;
  };

  it('rejects a missing, wrong or tampered signature and changes nothing', async () => {
    const co = await start();
    const body = JSON.stringify({ event: 'charge.success', data: { reference: co.payment.reference, status: 'success', amount: co.order.total * 100, currency: 'NGN' } });
    assert.equal((await post(body)).status, 401);
    assert.equal((await post(body, 'deadbeef')).status, 401);
    assert.equal((await post(body, sign(body, 'some_other_key'))).status, 401);
    assert.equal((await post(body.replace('success', 'sucess'), sign(body, SECRET))).status, 401);
    assert.equal((await h.ordersModel.findByRef(co.order.ref)).status, 'pending_payment');
  });

  it('accepts a correctly signed event, settles it, and answers 200 to a replay', async () => {
    const co = await start();
    const body = JSON.stringify({ event: 'charge.success', data: { reference: co.payment.reference, status: 'success', amount: co.order.total * 100, currency: 'NGN' } });
    const sig = sign(body, SECRET);
    const results = await Promise.all(Array.from({ length: 8 }, () => post(body, sig)));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal((await h.ordersModel.findByRef(co.order.ref)).status, 'paid');
    assert.equal(h.ordersModel._events.filter((e) => e.orderId === (h.ordersModel._orders.find((o) => o.publicRef === co.order.ref).id) && e.type === 'payment_confirmed').length, 1);
  });

  it('answers 200 to signed events it does not care about, and 400 to signed garbage', async () => {
    const other = JSON.stringify({ event: 'transfer.success', data: { reference: 'x' } });
    assert.equal((await post(other, sign(other, SECRET))).status, 200);
    const junk = 'not json';
    assert.equal((await post(junk, sign(junk, SECRET))).status, 400);
  });

  it('is not usable when no secret key is configured', async () => {
    const app = express();
    app.post('/hook', express.raw({ type: '*/*' }), createWebhookHandler({ service: h.service, secretKey: '' }));
    const s = http.createServer(app);
    await new Promise((r) => s.listen(0, r));
    const body = '{}';
    const res = await fetch(`http://127.0.0.1:${s.address().port}/hook`, { method: 'POST', headers: { 'x-paystack-signature': sign(body, '') }, body });
    s.close();
    assert.equal(res.status, 401);
  });
});

describe('rate limiting', () => {
  it('the checkout limiter blocks a flood with 429', async () => {
    const { checkoutLimiter } = await import('../src/middleware/rateLimits.js');
    const app = express();
    app.use(checkoutLimiter);
    app.post('/c', (req, res) => res.json({ ok: true }));
    const s = http.createServer(app);
    await new Promise((r) => s.listen(0, r));
    const url = `http://127.0.0.1:${s.address().port}/c`;
    let blocked = 0;
    for (let i = 0; i < 60; i++) if ((await fetch(url, { method: 'POST' })).status === 429) blocked += 1;
    s.close();
    assert.ok(blocked > 0 && blocked <= 60 - 40 + 0, `blocked ${blocked}`);
  });
  it('the dispatch limiter blocks a flood on rider links', async () => {
    const { dispatchLimiter } = await import('../src/middleware/rateLimits.js');
    const app = express();
    app.use(dispatchLimiter);
    app.get('/d', (req, res) => res.json({ ok: true }));
    const s = http.createServer(app);
    await new Promise((r) => s.listen(0, r));
    let blocked = 0;
    for (let i = 0; i < 80; i++) if ((await fetch(`http://127.0.0.1:${s.address().port}/d`)).status === 429) blocked += 1;
    s.close();
    assert.equal(blocked, 20);
  });
});
