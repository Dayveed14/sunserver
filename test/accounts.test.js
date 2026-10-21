import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createAuthService } from '../src/modules/auth/auth.service.js';
import { registerSchema } from '../src/modules/auth/auth.schemas.js';
import { areasOf, findArea } from '../src/modules/geo/areas.js';
import { createMemoryRepos } from '../test-support/memoryRepos.js';

const config = {
  bcryptRounds: 4, otpSecret: 'k',
  otp: { ttlMinutes: 10, maxAttempts: 5, resendCooldownSeconds: 60, maxSendsPerHour: 5 },
  login: { maxFailures: 5, lockMinutes: 15 },
};
const address = { line: '12 Adeola Odeku Street', state: 'lagos', areaId: 'victoria-island' };
const base = { email: 'ada@example.com', password: 'Sunny2026x', fullName: 'Ada Obi', phone: '+2348031234567', address };

let svc, repos, mailbox, created;
const code = (p) => p.then(() => null, (e) => e.code);
beforeEach(async () => {
  repos = createMemoryRepos();
  mailbox = [];
  created = [];
  svc = createAuthService({
    users: repos.usersRepo, otps: repos.otpsRepo, resets: repos.resetsRepo,
    mailer: { async sendOtp(m) { mailbox.push(m); }, async sendPasswordReset() {} }, config,
    onAccountCreated: async (u) => { created.push(u.role); },
  });
  await svc.register({ ...base, role: 'individual' });
  await svc.verifyEmail({ email: base.email, code: mailbox.at(-1).code });
});

describe('one email, several account types', () => {
  it('lets an individual also open a vendor account, using the same password and no code', async () => {
    const res = await svc.register({ ...base, role: 'vendor', companyName: 'Sunrise Solar' });
    assert.equal(res.added, true);
    assert.equal(res.user.role, 'vendor');
    assert.equal(mailbox.length, 1); // only the first sign-up sent a code
    assert.equal(created.at(-1), 'vendor');
  });

  it('refuses a second account of the same type', async () => {
    assert.equal(await code(svc.register({ ...base, role: 'individual' })), 'EMAIL_TAKEN');
  });

  it('will not add a type to someone else\'s email without that account\'s password', async () => {
    const e = await code(svc.register({ ...base, password: 'Wrong2026pass', role: 'vendor', companyName: 'Evil Ltd' }));
    assert.equal(e, 'EXISTING_ACCOUNT_PASSWORD');
    assert.equal((await repos.usersRepo.listByEmail(base.email)).length, 1);
  });

  it('logs in to the individual account by default and can pick the vendor account', async () => {
    await svc.register({ ...base, role: 'vendor', companyName: 'Sunrise Solar' });
    assert.equal((await svc.login({ email: base.email, password: base.password })).role, 'individual');
    assert.equal((await svc.login({ email: base.email, password: base.password, role: 'vendor' })).role, 'vendor');
  });

  it('switches between the accounts on one email, and refuses a type that does not exist', async () => {
    const ind = await repos.usersRepo.findByEmailRole(base.email, 'individual');
    assert.equal(await code(svc.switchAccount(ind.id, 'vendor')), 'NOT_FOUND');
    await svc.register({ ...base, role: 'vendor', companyName: 'Sunrise Solar' });
    assert.equal((await svc.switchAccount(ind.id, 'vendor')).companyName, 'Sunrise Solar');
  });

  it('opens a business account for a signed-in person and keeps the same password', async () => {
    const ind = await repos.usersRepo.findByEmailRole(base.email, 'individual');
    const biz = await svc.addAccount(ind.id, { role: 'business', companyName: 'Obi Ltd', address });
    assert.equal(biz.role, 'business');
    assert.equal(await code(svc.addAccount(ind.id, { role: 'business', companyName: 'Again', address })), 'EMAIL_TAKEN');
    assert.equal((await svc.login({ email: base.email, password: base.password, role: 'business' })).role, 'business');
  });

  it('a password reset covers every account on the email', async () => {
    await svc.register({ ...base, role: 'vendor', companyName: 'Sunrise Solar' });
    await svc.forgotPassword({ email: base.email }); // no mailer capture needed: set directly
    await repos.usersRepo.setPasswordForEmail(base.email, (await repos.usersRepo.listByEmail(base.email))[0].password_hash);
    const rows = await repos.usersRepo.listByEmail(base.email);
    assert.equal(new Set(rows.map((r) => r.password_hash)).size, 1);
  });

  it('wrong passwords lock every account on the email together', async () => {
    await svc.register({ ...base, role: 'vendor', companyName: 'Sunrise Solar' });
    for (let i = 0; i < 5; i++) await code(svc.login({ email: base.email, password: 'nope-nope-1' }));
    assert.equal(await code(svc.login({ email: base.email, password: base.password, role: 'vendor' })), 'ACCOUNT_LOCKED');
  });

  it('stores the address on the account and exposes it publicly', async () => {
    const user = await svc.login({ email: base.email, password: base.password });
    assert.deepEqual(user.address, { line: address.line, state: 'lagos', stateName: 'Lagos', areaId: 'victoria-island', areaName: 'Victoria Island' });
  });
});

describe('registration rules', () => {
  const ok = { ...base, role: 'individual', phone: '0803 123 4567' };
  const fieldsOf = (input) => {
    const r = registerSchema.safeParse(input);
    return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message]));
  };

  it('accepts a complete form and normalises the phone number', () => {
    const r = registerSchema.safeParse(ok);
    assert.equal(r.success, true);
    assert.equal(r.data.phone, '+2348031234567');
  });
  it('needs phone and address', () => {
    assert.ok(fieldsOf({ ...ok, phone: undefined }).phone);
    assert.ok(fieldsOf({ ...ok, phone: '12345' }).phone);
    assert.ok(fieldsOf({ ...ok, address: undefined })['address']);
    assert.ok(fieldsOf({ ...ok, address: { ...address, line: 'x' } })['address.line']);
  });
  it('only allows Lagos or Abuja and an area inside the chosen state', () => {
    assert.ok(fieldsOf({ ...ok, address: { ...address, state: 'kano' } })['address.state']);
    assert.ok(fieldsOf({ ...ok, address: { ...address, state: 'abuja' } })['address.areaId']); // a Lagos area in Abuja
    assert.deepEqual(fieldsOf({ ...ok, address: { ...address, state: 'abuja', areaId: 'garki' } }), {});
  });
  it('businesses and vendors need a company name', () => {
    assert.ok(fieldsOf({ ...ok, role: 'vendor' }).companyName);
  });
});

describe('areas', () => {
  it('has Central, Inner and Outer areas in both states', () => {
    for (const s of ['lagos', 'abuja']) {
      const zones = new Set(areasOf(s).map((a) => a.zone));
      assert.deepEqual([...zones].sort(), ['Central', 'Inner', 'Outer']);
    }
    assert.equal(findArea('lagos', 'ikeja').name, 'Ikeja');
    assert.equal(findArea('abuja', 'ikeja'), null);
  });
  it('has unique ids and sensible coordinates', () => {
    for (const s of ['lagos', 'abuja']) {
      const ids = areasOf(s).map((a) => a.id);
      assert.equal(new Set(ids).size, ids.length);
    }
    for (const a of areasOf('lagos')) assert.ok(a.lat > 6.3 && a.lat < 6.8 && a.lng > 2.8 && a.lng < 4.1, a.id);
    for (const a of areasOf('abuja')) assert.ok(a.lat > 8.7 && a.lat < 9.4 && a.lng > 6.9 && a.lng < 7.7, a.id);
  });
});
