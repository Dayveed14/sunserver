import crypto from 'node:crypto';

const API = 'https://api.paystack.co';

// Paystack signs every webhook with HMAC-SHA512 of the raw request body, using your secret key.
export function verifySignature(rawBody, signature, secret) {
  if (!secret || !signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Talks to Paystack. With no secret key (local testing only) it runs in a simulation mode: the "payment page" is
// one of our own pages with a button, and a payment counts as paid once that button is pressed.
export function createPaystack({ secretKey, clientOrigin, isProd, fetchImpl = fetch, timeoutMs = 12000 }) {
  const mock = !secretKey;
  if (mock && isProd) throw new Error('PAYSTACK_SECRET_KEY must be set in production.');
  const paid = new Set();

  async function call(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${API}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.status) throw new Error(body?.message ?? `Paystack returned ${res.status}`);
      return body.data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mock,
    // Starts a payment. `amountKobo` is in kobo (naira x 100).
    async initialize({ email, amountKobo, reference, callbackUrl, metadata, mockPath = '/checkout/mock' }) {
      if (mock) {
        return { authorizationUrl: `${clientOrigin.replace(/\/$/, '')}${mockPath}?reference=${encodeURIComponent(reference)}`, accessCode: 'mock' };
      }
      const d = await call('/transaction/initialize', {
        method: 'POST',
        body: JSON.stringify({ email, amount: amountKobo, currency: 'NGN', reference, callback_url: callbackUrl, metadata }),
      });
      return { authorizationUrl: d.authorization_url, accessCode: d.access_code };
    },
    // Asks Paystack what really happened to a payment. Never trust the browser's word for it.
    async verify(reference) {
      if (mock) return paid.has(reference) ? { status: 'success', amountKobo: null, currency: 'NGN', reference } : { status: 'abandoned', reference };
      const d = await call(`/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET' });
      return { status: d.status, amountKobo: d.amount, currency: d.currency, reference: d.reference };
    },
    // Simulation only.
    markMockPaid(reference) {
      if (!mock) throw new Error('Simulation is off');
      paid.add(reference);
    },
  };
}
