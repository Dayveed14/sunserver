// Creates the database and tables from sql/*.sql (schema.sql first, then 002_*.sql, 003_*.sql…).
// Every file is idempotent, so running this again on an existing database only adds what is missing.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { migrate } from './migrate.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const files = ['schema.sql', ...fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && f !== 'schema.sql').sort()];

// The .sql files say "solalium"; use the database name from .env instead, so a different DB_NAME (for example one made in phpMyAdmin) is the one that gets built.
const dbName = process.env.DB_NAME ?? 'solalium';
if (!/^[A-Za-z0-9_]{1,64}$/.test(dbName)) throw new Error('DB_NAME may only contain letters, numbers and underscores.');
const forThisDatabase = (sql) => sql.replace(/^(CREATE DATABASE IF NOT EXISTS )solalium\b/gim, `$1\`${dbName}\``).replace(/^USE solalium;/gim, `USE \`${dbName}\`;`);

const conn = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  multipleStatements: true,
  ssl: ((process.env.DB_SSL ? process.env.DB_SSL === 'true' : !['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '127.0.0.1'))) ? { minVersion: 'TLSv1.2' } : undefined,
});

try {
  for (const file of files) {
    await conn.query(forThisDatabase(fs.readFileSync(path.join(dir, file), 'utf8')));
    await conn.query(`USE \`${dbName}\``);
    console.log(`Applied ${file}`);
  }
  await migrate(conn, dbName);
  console.log('Database ready.');
} finally {
  await conn.end();
}
