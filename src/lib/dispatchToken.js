import crypto from 'node:crypto';

// A link the logistics partner can use without an account: "mark picked up" / "mark delivered" for one vendor order.
// The token is signed, so it cannot be forged or changed to point at another order.
export function createDispatchTokens(secret) {
  const mac = (payload) => crypto.createHmac('sha256', secret).update(`dispatch:${payload}`).digest('base64url');
  return {
    sign(voId, action) {
      const payload = Buffer.from(JSON.stringify({ vo: Number(voId), a: action })).toString('base64url');
      return `${payload}.${mac(payload)}`;
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 200) return null;
      const [payload, sig] = token.split('.');
      if (!payload || !sig) return null;
      const expected = Buffer.from(mac(payload));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
      try {
        const { vo, a } = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return Number.isInteger(vo) && (a === 'pickup' || a === 'deliver') ? { voId: vo, action: a } : null;
      } catch {
        return null;
      }
    },
  };
}
