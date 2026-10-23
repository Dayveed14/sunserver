import crypto from 'node:crypto';

// Cloudinary stores and serves our product pictures. We upload with a signed request from the server (the secret
// never reaches the browser) and keep only the web address. Delivery goes through Cloudinary's CDN, which also
// resizes and picks the best format (WebP/AVIF) for each visitor.
export function parseCloudinaryUrl(value) {
  const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(value ?? '');
  return m ? { apiKey: m[1], apiSecret: m[2], cloudName: m[3] } : null;
}

export function createCloudinary({ cloudName, apiKey, apiSecret, folder = 'solalium', fetchImpl = fetch, timeoutMs = 20000, now = () => Date.now() }) {
  const enabled = Boolean(cloudName && apiKey && apiSecret);
  const sign = (params) => {
    const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
  };

  async function call(path, form) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`https://api.cloudinary.com/v1_1/${cloudName}${path}`, { method: 'POST', body: form, signal: controller.signal });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.error) throw new Error(body?.error?.message ?? `Cloudinary returned ${res.status}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled,
    // Uploads one picture. Returns the permanent address and Cloudinary's id for it.
    async upload(buffer, mime) {
      const timestamp = Math.floor(now() / 1000);
      const signed = { folder, timestamp };
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mime }), 'upload');
      form.append('api_key', apiKey);
      form.append('timestamp', String(timestamp));
      form.append('folder', folder);
      form.append('signature', sign(signed));
      const r = await call('/image/upload', form);
      return { url: r.secure_url, publicId: r.public_id };
    },
    // Removes a picture we no longer use. Failure is harmless (an orphan costs almost nothing), so callers may ignore it.
    async destroy(publicId) {
      const timestamp = Math.floor(now() / 1000);
      const form = new FormData();
      form.append('public_id', publicId);
      form.append('api_key', apiKey);
      form.append('timestamp', String(timestamp));
      form.append('signature', sign({ public_id: publicId, timestamp }));
      return call('/image/destroy', form);
    },
  };
}

// The address of a smaller, web-optimised version of a Cloudinary picture.
export const optimisedUrl = (url, transform = 'f_auto,q_auto,w_900,c_limit') =>
  url.includes('/upload/') ? url.replace('/upload/', `/upload/${transform}/`) : url;
