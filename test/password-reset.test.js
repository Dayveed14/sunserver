import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createAuthService } from '../src/modules/auth/auth.service.js';
import { createMemoryRepos } from '../test-support/memoryRepos.js';

const MIN = 60 * 1000;
const config = {
  bcryptRounds: 4,
  otpSecret: 'test-secret',
  otp: { ttlMinutes: 10, maxAttempts: 5, resendCooldownSeconds: 60, maxSendsPerHour: 5 },
  login: { maxFailures: 5, lockMinutes: 15 },
  reset: { ttlMinutes: 60, cooldownSeconds: 60, maxPerHour: 3 },
  resetLink: (t) => `https://app.test/reset-password?token=${t}`,
};
const signup = { email: 'ada@example.com', password: 'Sunny2026x', role: 'individual', fullName: 'Ada Obi' };

let svc, repos, otpBox, resetBox, clock, failMail;
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };
const tokenOf = (msg) => new URL(msg.link).searchParams.get('token');
const fails = (p) => p.then(() => null, (e) => e.code);

beforeEach(async () => {
  repos = createMemoryRepos();
  otpBox = []; resetBox = [];
  clock = new Date('2026-10-17T09:00:00Z');
  failMail = false;
  const mailer = {
    async sendOtp(m) { otpBox.push(m); },
    async sendPasswordReset(m) { if (failMail) throw new Error('down'); resetBox.push(m); },
  };
  svc = createAuthService({ users: repos.usersRepo, otps: repos.otpsRepo, resets: repos.resetsRepo, mailer, config, now: () => clock });
  await svc.register(signup);
  await svc.verifyEmail({ email: signup.email, code: otpBox.at(-1).code });
  advance(2 * MIN);
});

describe('forgot password', () => {
  it('emails a one-time link and stores only a hash of the token', async () => {
    await svc.forgotPassword({ email: signup.email });
    assert.equal(resetBox.length, 1);
    const token = tokenOf(resetBox[0]);
    assert.ok(token.length >= 40);
    assert.ok(!repos.resetRows[0].token_hash.includes(token));
  });

  it('answers the same for unknown, unverified and suspended accounts, and sends nothing', async () => {
    assert.deepEqual(await svc.forgotPassword({ email: 'nobody@example.com' }), { ok: true });
    await svc.register({ ...signup, email: 'new@example.com' }); // never verified
    assert.deepEqual(await svc.forgotPassword({ email: 'new@example.com' }), { ok: true });
    repos.users.get(1).status = 'suspended';
    assert.deepEqual(await svc.forgotPassword({ email: signup.email }), { ok: true });
    assert.equal(resetBox.length, 0);
  });

  it('quietly limits how often links can be requested', async () => {
    await svc.forgotPassword({ email: signup.email });
    await svc.forgotPassword({ email: signup.email }); // inside the cooldown
    assert.equal(resetBox.length, 1);
    for (let i = 0; i < 4; i++) { advance(2 * MIN); await svc.forgotPassword({ email: signup.email }); }
    assert.equal(resetBox.length, 3); // hourly cap
  });

  it('still answers ok if the email fails to send, and leaves no usable link behind', async () => {
    failMail = true;
    assert.deepEqual(await svc.forgotPassword({ email: signup.email }), { ok: true });
    assert.equal(repos.resetRows.length, 0);
  });
});

describe('reset password', () => {
  const request = async () => { await svc.forgotPassword({ email: signup.email }); return tokenOf(resetBox.at(-1)); };

  it('sets the new password, ends old sessions and clears a lockout', async () => {
    const before = repos.users.get(1).token_version;
    repos.users.get(1).locked_until = new Date(clock.getTime() + 10 * MIN);
    const token = await request();
    await svc.resetPassword({ token, password: 'Brand9newPass' });
    assert.equal(repos.users.get(1).token_version, before + 1);
    assert.equal(repos.users.get(1).locked_until, null);
    assert.equal((await svc.login({ email: signup.email, password: 'Brand9newPass' })).email, signup.email);
    assert.equal(await fails(svc.login({ email: signup.email, password: signup.password })), 'INVALID_CREDENTIALS');
  });

  it('works only once', async () => {
    const token = await request();
    await svc.resetPassword({ token, password: 'Brand9newPass' });
    assert.equal(await fails(svc.resetPassword({ token, password: 'Another9pass' })), 'INVALID_RESET');
  });

  it('a newer link kills the older one after a reset', async () => {
    const first = await request();
    advance(2 * MIN);
    const second = await request();
    await svc.resetPassword({ token: second, password: 'Brand9newPass' });
    assert.equal(await fails(svc.resetPassword({ token: first, password: 'Another9pass' })), 'INVALID_RESET');
  });

  it('rejects expired and made-up tokens', async () => {
    const token = await request();
    advance(61 * MIN);
    assert.equal(await fails(svc.resetPassword({ token, password: 'Brand9newPass' })), 'INVALID_RESET');
    assert.equal(await fails(svc.resetPassword({ token: 'x'.repeat(43), password: 'Brand9newPass' })), 'INVALID_RESET');
  });

  it('does not let a suspended account back in through a link requested earlier', async () => {
    const token = await request();
    repos.users.get(1).status = 'suspended';
    assert.equal(await fails(svc.resetPassword({ token, password: 'Brand9newPass' })), 'INVALID_RESET');
  });
});
