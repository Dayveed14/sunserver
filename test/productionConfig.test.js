import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

// Each case starts a fresh Node process, because the settings are read once when the server starts.
const boot = (env) => spawnSync(process.execPath, ['-e', "await import('./src/services/index.js'); console.log('BOOTED')"], {
  cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', input: '',
  env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env }, timeout: 20000,
});
const good = { JWT_SECRET: 'x'.repeat(40), CLIENT_ORIGIN: 'https://solalium.example', PAYSTACK_SECRET_KEY: 'sk_test_x' };

describe('production start-up refuses unsafe settings', () => {
  it('starts with good settings', () => { assert.match(boot(good).stdout, /BOOTED/); });
  it('refuses a short or missing JWT secret', () => {
    assert.doesNotMatch(boot({ ...good, JWT_SECRET: 'short' }).stdout, /BOOTED/);
    assert.doesNotMatch(boot({ ...good, JWT_SECRET: '' }).stdout, /BOOTED/);
  });
  it('refuses a missing, http or localhost site address', () => {
    for (const CLIENT_ORIGIN of ['', 'http://solalium.example', 'http://localhost:5173', 'https://solalium.example/', 'solalium.example']) {
      assert.doesNotMatch(boot({ ...good, CLIENT_ORIGIN }).stdout, /BOOTED/, CLIENT_ORIGIN);
    }
  });
  it('refuses to run without a Paystack key, so simulated payments can never be live', () => {
    assert.doesNotMatch(boot({ ...good, PAYSTACK_SECRET_KEY: '' }).stdout, /BOOTED/);
  });
});
