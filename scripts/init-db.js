// Creates the database and tables from sql/*.sql (schema.sql first, then 002_*.sql, 003_*.sql…).
// Every file is idempotent, so running this again on an existing database only adds what is missing.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const files = ['schema.sql', ...fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && f !== 'schema.sql').sort()];

const conn = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  multipleStatements: true,
});

try {
  for (const file of files) {
    await conn.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    console.log(`Applied ${file}`);
  }
  console.log('Database ready.');
} finally {
  await conn.end();
}
