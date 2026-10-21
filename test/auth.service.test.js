import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createAuthService } from '../src/services/auth.service.js';
import { createMemoryModels } from '../test-support/memoryModels.js';

const MIN = 60 * 1000;
const config = {
  bcryptRounds: 4, // fast hashing for tests only
  otpSecret: 'test-secret',
  otp: { ttlMinutes: 10, maxAttempts: 5, resendCooldownSeconds: 60, maxSendsPerHour: 5 },
  login: { maxFailures: 5, lockMinutes: 15 },
};
const signup = { email: 'ada@example.com', password: 'Sunny2026x', role: 'individual', fullName: 'Ada Obi' };

let svc, models, mailbox, clock, failMail;
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };
const lastCode = () => mailbox.at(-1).code;
const wrongCode = () => (lastCode() === '000000' ? '111111' : '000000');
const code = async (promise) => promise.then(() => null, (e) => e.code);

beforeEach(() => {
  models = createMemoryModels();
  mailbox = [];
  clock = new Date('2026-10-16T12:00:00Z');
  failMail = false;
  const mailer = {
    async sendOtp(msg) {
      if (failMail) throw new Error('resend down');
      mailbox.push(msg);
    },
  };
  svc = createAuthService({ users: models.usersModel, otps: models.otpsModel, mailer, config, now: () => clock });
});

describe('registration + OTP', () => {
  it('creates an unverified account, emails a 6-digit code, and stores only a hash of it', async () => {
    await svc.register(signup);
    assert.equal(mailbox.length, 1);
    assert.match(lastCode(), /^\d{6}$/);
    const row = models.otpRows[0];
    assert.equal(row.code_hash.length, 64);
    assert.ok(!row.code_hash.includes(lastCode()));
    assert.equal((await models.usersModel.findByEmailRole(signup.email, 'individual')).email_verified_at, null);
  });

  it('never stores the password in plain text', async () => {
    await svc.register(signup);
    const user = await models.usersModel.findByEmailRole(signup.email, 'individual');
    assert.notEqual(user.password_hash, signup.password);
    assert.match(user.password_hash, /^\$2[aby]\$/);
  });

  it('verifies with the right code and returns a public user (no hash)', async () => {
    await svc.register(signup);
    const user = await svc.verifyEmail({ email: signup.email, code: lastCode() });
    assert.equal(user.emailVerified, true);
    assert.equal(user.role, 'individual');
    assert.equal(user.password_hash, undefined);
  });

  it('counts down wrong guesses, then refuses even the right code until a new one is requested', async () => {
    await svc.register(signup);
    const real = lastCode();
    for (let i = 0; i < 5; i++) assert.equal(await code(svc.verifyEmail({ email: signup.email, code: wrongCode() })), 'INVALID_CODE');
    assert.equal(await code(svc.verifyEmail({ email: signup.email, code: real })), 'TOO_MANY_ATTEMPTS');
    advance(61 * 1000);
    await svc.resendOtp({ email: signup.email });
    assert.ok((await svc.verifyEmail({ email: signup.email, code: lastCode() })).emailVerified);
  });

  it('rejects an expired code', async () => {
    await svc.register(signup);
    advance(11 * MIN);
    assert.equal(await code(svc.verifyEmail({ email: signup.email, code: lastCode() })), 'CODE_EXPIRED');
  });

  it('invalidates the previous code when a new one is sent', async () => {
    await svc.register(signup);
    const first = lastCode();
    advance(61 * 1000);
    await svc.resendOtp({ email: signup.email });
    if (first !== lastCode()) {
      assert.equal(await code(svc.verifyEmail({ email: signup.email, code: first })), 'INVALID_CODE');
    }
    assert.ok((await svc.verifyEmail({ email: signup.email, code: lastCode() })).emailVerified);
  });

  it('enforces a resend cooldown and an hourly cap', async () => {
    await svc.register(signup);
    assert.equal(await code(svc.resendOtp({ email: signup.email })), 'OTP_COOLDOWN');
    for (let i = 0; i < 4; i++) { advance(61 * 1000); await svc.resendOtp({ email: signup.email }); }
    advance(61 * 1000);
    assert.equal(await code(svc.resendOtp({ email: signup.email })), 'OTP_LIMIT');
  });

  it('does not count a code that failed to send', async () => {
    failMail = true;
    assert.equal(await code(svc.register(signup)), 'MAIL_FAILED');
    assert.equal(models.otpRows.length, 0);
    failMail = false;
    await svc.register(signup); // no cooldown penalty
    assert.equal(mailbox.length, 1);
  });

  it('refuses a verified account of the same type, but lets an unverified one start over with new details', async () => {
    await svc.register(signup);
    advance(61 * 1000);
    await svc.register({ ...signup, fullName: 'Ada O.' });
    const user = await models.usersModel.findByEmailRole(signup.email, 'individual');
    assert.equal(user.full_name, 'Ada O.');
    await svc.verifyEmail({ email: signup.email, code: lastCode() });
    assert.equal(await code(svc.register(signup)), 'EMAIL_TAKEN');
  });

  it('gives the same answer for unknown emails when asked to resend (no account enumeration)', async () => {
    const out = await svc.resendOtp({ email: 'ghost@example.com' });
    assert.ok(out.resendInSeconds > 0);
    assert.equal(mailbox.length, 0);
  });
});

describe('login (no OTP)', () => {
  const verified = async () => {
    await svc.register(signup);
    await svc.verifyEmail({ email: signup.email, code: lastCode() });
  };

  it('logs a verified user in with just email and password', async () => {
    await verified();
    const user = await svc.login({ email: signup.email, password: signup.password });
    assert.equal(user.email, signup.email);
    assert.equal(mailbox.length, 1, 'no extra email is sent on login');
  });

  it('gives one vague error for wrong password and unknown email', async () => {
    await verified();
    assert.equal(await code(svc.login({ email: signup.email, password: 'wrong-pass1' })), 'INVALID_CREDENTIALS');
    assert.equal(await code(svc.login({ email: 'ghost@example.com', password: 'whatever1' })), 'INVALID_CREDENTIALS');
  });

  it('sends unverified users to verification and mails a fresh code', async () => {
    await svc.register(signup);
    advance(61 * 1000);
    assert.equal(await code(svc.login({ email: signup.email, password: signup.password })), 'EMAIL_NOT_VERIFIED');
    assert.equal(mailbox.length, 2);
  });

  it('locks the account after 5 wrong passwords, even for the right one, then unlocks', async () => {
    await verified();
    for (let i = 0; i < 5; i++) await code(svc.login({ email: signup.email, password: 'wrong-pass1' }));
    assert.equal(await code(svc.login({ email: signup.email, password: signup.password })), 'ACCOUNT_LOCKED');
    advance(16 * MIN);
    assert.ok((await svc.login({ email: signup.email, password: signup.password })).emailVerified);
  });

  it('resets the failure count after a successful login', async () => {
    await verified();
    for (let i = 0; i < 4; i++) await code(svc.login({ email: signup.email, password: 'wrong-pass1' }));
    await svc.login({ email: signup.email, password: signup.password });
    for (let i = 0; i < 4; i++) await code(svc.login({ email: signup.email, password: 'wrong-pass1' }));
    assert.ok((await svc.login({ email: signup.email, password: signup.password })).emailVerified);
  });

  it('blocks suspended accounts', async () => {
    await verified();
    (await models.users.get(1)).status = 'suspended';
    assert.equal(await code(svc.login({ email: signup.email, password: signup.password })), 'ACCOUNT_SUSPENDED');
  });
});
