import { verifySignature } from '../lib/paystack.js';

// Paystack calls this when a payment succeeds. The body must arrive untouched (raw bytes) because the
// signature is a hash of exactly those bytes. Anything that is not signed by Paystack is turned away.
// Paystack retries until it gets a 200, so every verified event is answered 200 even if we ignore it.
export function createWebhookHandler({ service, secretKey }) {
  return async (req, res) => {
    const raw = req.body;
    if (!verifySignature(raw, req.get('x-paystack-signature'), secretKey)) {
      return res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid signature.' } });
    }
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: { code: 'BAD_BODY', message: 'Invalid body.' } });
    }
    try {
      await service.handleWebhook(event);
    } catch (err) {
      // Our fault, not theirs: ask Paystack to try again later.
      console.error('[webhook] failed:', err.message);
      return res.status(500).json({ error: { code: 'WEBHOOK_FAILED', message: 'Try again.' } });
    }
    res.json({ received: true });
  };
}
