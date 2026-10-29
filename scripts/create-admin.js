// Admin accounts cannot be created from the public sign-up. Create one here:
//   ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='a-long-password' ADMIN_NAME='Your Name' npm run create-admin
import bcrypt from 'bcryptjs';
import { env } from '../src/config/env.js';
import { pool, query } from '../src/db/pool.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME?.trim() || 'Solariun Admin';

if (!email || !password) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (and optionally ADMIN_NAME).');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Use an admin password of at least 12 characters.');
  process.exit(1);
}

try {
  const hash = await bcrypt.hash(password, env.bcryptRounds);
  await query(
    `INSERT INTO users (email, password_hash, role, full_name, email_verified_at)
     VALUES (?, ?, 'admin', ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin',
       email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()), token_version = token_version + 1`,
    [email, hash, name]
  );
  console.log(`Admin ready: ${email}`);
} finally {
  await pool.end();
}
