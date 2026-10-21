import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { createCloudinary, optimisedUrl, parseCloudinaryUrl } from '../src/lib/cloudinary.js';
import { createImageService } from '../src/modules/media/images.service.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

describe('Cloudinary', () => {
  it('reads the CLOUDINARY_URL from the dashboard', () => {
    assert.deepEqual(parseCloudinaryUrl('cloudinary://123:abc_secret@mycloud'), { apiKey: '123', apiSecret: 'abc_secret', cloudName: 'mycloud' });
    assert.equal(parseCloudinaryUrl(''), null);
  });
  it('uploads with a correct signature and never sends the secret', async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, form: init.body }; return { ok: true, json: async () => ({ secure_url: 'https://res.cloudinary.com/mycloud/image/upload/v1/sunledger/a.png', public_id: 'sunledger/a' }) }; };
    const c = createCloudinary({ cloudName: 'mycloud', apiKey: 'KEY', apiSecret: 'SECRET', fetchImpl, now: () => 1_700_000_000_000 });
    const r = await c.upload(PNG, 'image/png');
    assert.equal(seen.url, 'https://api.cloudinary.com/v1_1/mycloud/image/upload');
    const expected = crypto.createHash('sha1').update('folder=sunledger&timestamp=1700000000SECRET').digest('hex');
    assert.equal(seen.form.get('signature'), expected);
    assert.equal(seen.form.get('api_key'), 'KEY');
    assert.ok(![...seen.form.values()].some((v) => v === 'SECRET'));
    assert.equal(r.publicId, 'sunledger/a');
  });
  it('asks for a smaller, best-format version when serving', () => {
    assert.equal(optimisedUrl('https://res.cloudinary.com/m/image/upload/v1/a.png'), 'https://res.cloudinary.com/m/image/upload/f_auto,q_auto,w_900,c_limit/v1/a.png');
  });
});

describe('image storage', () => {
  const repo = () => { const rows = []; return { rows, async create(r) { rows.push(r); return rows.length; } }; };
  it('keeps only the address when Cloudinary is on', async () => {
    const r = repo();
    const svc = createImageService({ imagesRepo: r, cloudinary: { enabled: true, async upload() { return { url: 'https://res.cloudinary.com/m/image/upload/a.png', publicId: 'p' }; } } });
    const out = await svc.store(5, PNG);
    assert.equal(out.url, '/api/images/1');
    assert.equal(r.rows[0].data, null);
    assert.equal(r.rows[0].remote.publicId, 'p');
  });
  it('falls back to the database when Cloudinary is not set up', async () => {
    const r = repo();
    const svc = createImageService({ imagesRepo: r, cloudinary: { enabled: false } });
    await svc.store(5, PNG);
    assert.ok(Buffer.isBuffer(r.rows[0].data) && !r.rows[0].remote);
  });
  it('rejects non-pictures before any upload happens', async () => {
    let called = false;
    const svc = createImageService({ imagesRepo: repo(), cloudinary: { enabled: true, async upload() { called = true; } } });
    await assert.rejects(svc.store(5, Buffer.from('<?php echo 1; ?> not an image at all')), (e) => e.code === 'INVALID_IMAGE');
    assert.equal(called, false);
  });
  it('reports a clear error if Cloudinary is down, and saves nothing', async () => {
    const r = repo();
    const svc = createImageService({ imagesRepo: r, cloudinary: { enabled: true, async upload() { throw new Error('boom'); } } });
    await assert.rejects(svc.store(5, PNG), (e) => e.code === 'UPLOAD_FAILED');
    assert.equal(r.rows.length, 0);
  });
});
