import mysql from 'mysql2/promise';

import { env } from '../config/env.js';

export const pool = mysql.createPool({
host: env.db.host,
port: env.db.port,
user: env.db.user,
password: env.db.password,
database: env.db.database,

// Require an encrypted connection to TiDB Cloud.
ssl: {
minVersion: 'TLSv1.2',
},

waitForConnections: true,
connectionLimit: 10,
charset: 'utf8mb4',
timezone: 'Z',
decimalNumbers: true,
});

// Keep every connection on UTC so created_at defaults match the JS dates we pass in.
pool.pool.on('connection', (conn) => {
conn.query("SET time_zone = '+00:00'");
});

export async function query(sql, params = []) {
const [rows] = await pool.execute(sql, params);
return rows;
}

export async function withTransaction(fn) {
const conn = await pool.getConnection();

try {
await conn.beginTransaction();
const result = await fn(conn);
await conn.commit();
return result;
} catch (err) {
await conn.rollback();
throw err;
} finally {
conn.release();
}
}
