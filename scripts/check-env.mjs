// Run this against your PRODUCTION settings before (and after) a deploy:
//   NODE_ENV=production node scripts/check-env.mjs            (with the same variables you set on Render)
// It prints what is wrong in plain words and exits with 1 if anything must be fixed. It sends no email and charges no one.
import net from 'node:net';

const problems = [];
const warnings = [];
const e = process.env;
const need = (name, why) => { if (!e[name]) problems.push(`${name} is not set. ${why}`); };

if (e.NODE_ENV !== 'production') warnings.push('NODE_ENV is not "production". Set it on Render, otherwise cookies are not marked Secure.');
need('DB_HOST', 'The database address.'); need('DB_USER', 'The database user.'); need('DB_PASSWORD', 'The database password.'); need('DB_NAME', 'The database name.');
if (!e.JWT_SECRET || e.JWT_SECRET.length < 32) problems.push('JWT_SECRET must be a random string of at least 32 characters.');
if (!/^https:\/\/[^/]+$/.test(e.CLIENT_ORIGIN ?? '')) problems.push('CLIENT_ORIGIN must look like https://yourdomain.com (https, no path, no trailing slash). Emails, payment returns and CORS all use it.');
else if (/localhost|127\.0\.0\.1|\.vercel\.app$/.test(e.CLIENT_ORIGIN)) warnings.push(`CLIENT_ORIGIN is ${e.CLIENT_ORIGIN}. Fine for testing, but switch to your real domain before launch.`);
if (!/^sk_(live|test)_/.test(e.PAYSTACK_SECRET_KEY ?? '')) problems.push('PAYSTACK_SECRET_KEY must start with sk_live_ (or sk_test_ while testing). Without it the server refuses to start in production.');
else if (e.PAYSTACK_SECRET_KEY.startsWith('sk_test_')) warnings.push('PAYSTACK_SECRET_KEY is a TEST key: no real money will move.');
if (!e.RESEND_API_KEY) problems.push('RESEND_API_KEY is not set: nobody will receive verification codes, reset links or order emails.');
if (/onboarding@resend\.dev/.test(e.MAIL_FROM ?? 'onboarding@resend.dev')) problems.push('MAIL_FROM still uses onboarding@resend.dev, which only delivers to your own Resend account. Verify a domain in Resend and use an address on it.');
if (!e.CLOUDINARY_URL && !(e.CLOUDINARY_CLOUD_NAME && e.CLOUDINARY_API_KEY && e.CLOUDINARY_API_SECRET)) warnings.push('Cloudinary is not set: product pictures will be stored in the database (works, but bloats backups).');
if (!e.LOGISTICS_EMAIL) warnings.push('LOGISTICS_EMAIL is not set: nobody is told to send a rider.');
if (!e.ADMIN_NOTIFY_EMAIL) warnings.push('ADMIN_NOTIFY_EMAIL is not set: nobody gets payment-problem alerts.');
if (!e.TRUST_PROXY || e.TRUST_PROXY === '0') warnings.push('TRUST_PROXY is 0: behind Render every visitor looks like the same IP, so one person can lock everyone out of login. Use 1 (Render only) or 2 (Vercel rewrite to Render).');
if (e.DB_SSL === 'false' && !['127.0.0.1', 'localhost'].includes(e.DB_HOST)) warnings.push('DB_SSL=false with a remote database: traffic is not encrypted. TiDB Cloud requires SSL.');

// live checks
let dbOk = false;
if (e.DB_HOST && problems.some((x) => /^(JWT_SECRET|CLIENT_ORIGIN)/.test(x))) warnings.push('Skipped the database check: fix JWT_SECRET and CLIENT_ORIGIN first (the server will not start without them).');
else if (e.DB_HOST) {
  try {
    const { pool, query } = await import('../src/db/pool.js');
    const rows = await query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    dbOk = true;
    if (Number(rows[0].n) < 10) problems.push(`Connected, but the database has only ${rows[0].n} tables. Run "npm run db:init" once against it.`);
    const col = await query("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'category'");
    if (col[0] && !String(col[0].t).includes("'kit'")) problems.push('products.category does not have the new product types yet. Run "npm run db:init" or server/sql/manual/add-product-categories.sql.');
    const need10 = await query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('verification_documents','installer_profiles','install_requests','articles')");
    if (Number(need10[0].n) < 4) problems.push('The Phase 8 tables (verification, installations, blog) are missing. Run "npm run db:init".');
    else {
      const pend = await query("SELECT COUNT(*) n FROM vendor_profiles WHERE verification_status = 'pending'");
      if (Number(pend[0].n)) warnings.push(`${pend[0].n} vendor(s) are waiting for approval (Admin > Vendors). Until approved they are hidden from the shop and cannot post.`);
    }
    const admins = await query("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND status = 'active'");
    if (!Number(admins[0].n)) warnings.push('There is no admin account yet. Run "npm run create-admin".');
    await pool.end();
  } catch (err) {
    problems.push(`Cannot connect to the database: ${err.code ?? err.message}. Check host, port, user, password, DB_NAME and SSL.`);
  }
}
if (!dbOk && e.DB_HOST) void net;

console.log(`\nSolariun production check\n${'-'.repeat(25)}`);
for (const p of problems) console.log(`FIX    ${p}`);
for (const w of warnings) console.log(`NOTE   ${w}`);
if (!problems.length && !warnings.length) console.log('Everything looks right.');
console.log(`\n${problems.length} to fix, ${warnings.length} notes.`);
process.exit(problems.length ? 1 : 0);
