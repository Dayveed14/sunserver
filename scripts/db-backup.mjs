// A full logical backup of the database as one compressed .sql file, using only Node (no mysqldump needed).
//   npm run db:backup                  -> backups/solalium-2026-10-24T1530.sql.gz
//   npm run db:backup -- my-file.sql.gz
// The file contains customer emails and password hashes: keep it private and never commit it (backups/ is git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { pool, query } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

const stamp = new Date().toISOString().slice(0, 16).replace(/[:]/g, '');
const out = path.resolve(process.argv[2] ?? `backups/${env.db.database}-${stamp}.sql.gz`);
fs.mkdirSync(path.dirname(out), { recursive: true });
// JSON columns come back from the driver as objects; write them back as JSON text.
const lit = (v) => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) ? pool.escape(JSON.stringify(v)) : pool.escape(v));
const q = (name) => `\`${String(name).replace(/`/g, '``')}\``;

async function* dump() {
  yield `-- Solalium backup of ${env.db.database}, made ${new Date().toISOString()}\nSET FOREIGN_KEY_CHECKS=0;\nSET NAMES utf8mb4;\nSET time_zone='+00:00';\n\n`;
  const tables = (await query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name")).map((r) => r.name ?? r.TABLE_NAME);
  for (const t of tables) {
    const [{ 'Create Table': create }] = await query(`SHOW CREATE TABLE ${q(t)}`);
    yield `DROP TABLE IF EXISTS ${q(t)};\n${create};\n`;
    let rows = 0;
    for (let offset = 0; ; offset += 500) {
      // Stable order so pages never overlap: every table here has an auto-increment id or a primary key.
      const page = await query(`SELECT * FROM ${q(t)} ORDER BY 1 LIMIT 500 OFFSET ${offset}`);
      if (!page.length) break;
      const cols = Object.keys(page[0]).map(q).join(', ');
      const values = page.map((r) => `(${Object.values(r).map((v) => lit(v)).join(', ')})`).join(',\n');
      yield `INSERT INTO ${q(t)} (${cols}) VALUES\n${values};\n`;
      rows += page.length;
    }
    console.error(`  ${t}: ${rows} rows`);
  }
  yield '\nSET FOREIGN_KEY_CHECKS=1;\n-- end of backup\n';
}

try {
  await pipeline(Readable.from(dump()), zlib.createGzip(), fs.createWriteStream(out));
  console.log(`Backup written: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
} finally {
  await pool.end();
}
