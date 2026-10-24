// Restores a backup made by `npm run db:backup` into the database named in your .env.
//   npm run db:restore -- backups/solalium-2026-10-24T1530.sql.gz
// It REPLACES every table in the file. To protect you, it refuses to run if the target database already has data
// unless you add --force. Practise a restore into an empty scratch database before you ever need it for real.
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { pool, query } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');
if (!file || !fs.existsSync(file)) { console.error('Usage: npm run db:restore -- <backup.sql.gz> [--force]'); process.exit(1); }

try {
  const [{ n }] = await query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
  if (Number(n) > 0 && !force) {
    console.error(`${env.db.database} already has ${n} tables. Restoring replaces them. Re-run with --force if that is what you want.`);
    process.exit(1);
  }
  const input = file.endsWith('.gz') ? fs.createReadStream(file).pipe(zlib.createGunzip()) : fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let stmt = '';
  let count = 0;
  const conn = await pool.getConnection();
  try {
    // The backup writes each statement so that it ends a line with ";" and no row text contains a raw line break
    // followed by ";" at its end, because values are escaped. A statement ends at a line ending in ";" outside quotes.
    let inQuote = false;
    for await (const line of lines) {
      if (!stmt && (line.startsWith('--') || !line.trim())) continue;
      stmt += (stmt ? '\n' : '') + line;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\\' && inQuote) { i++; continue; }
        if (ch === "'") inQuote = !inQuote;
      }
      if (!inQuote && stmt.trimEnd().endsWith(';')) { await conn.query(stmt); stmt = ''; count++; }
    }
    if (stmt.trim()) throw new Error('The backup file ends in the middle of a statement: it is incomplete.');
  } finally {
    conn.release();
  }
  console.log(`Restored ${count} statements into ${env.db.database}.`);
} finally {
  await pool.end();
}
