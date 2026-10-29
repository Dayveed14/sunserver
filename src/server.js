import { env } from './config/env.js';
import { createApp } from './app.js';
import { pool, query } from './db/pool.js';
import { adminService, startHousekeeping } from './services/index.js';

const log = (level, msg, extra = {}) => console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, msg, ...extra }));

// Fail fast in production if the database cannot be reached (wrong password, SSL, firewall), instead of
// starting and answering every request with an error.
try {
  await query('SELECT 1');
} catch (err) {
  log('error', 'cannot reach the database', { code: err.code ?? err.message, host: env.db.host });
  if (env.isProd) process.exit(1);
  console.warn('[db] could not connect. Run "npm run db:init" after starting MySQL.');
}

// Pick up any pricing changes an admin saved earlier. If the table is missing (db:init not run yet) carry on with defaults.
try {
  const { applied } = await adminService.loadSettings();
  if (applied) console.log(`[admin] loaded ${applied} saved pricing setting(s).`);
} catch (err) {
  console.warn('[admin] could not load saved pricing settings:', err.code ?? err.message);
}

const app = createApp();
const stopHousekeeping = startHousekeeping();
const server = app.listen(env.port, () => {
  console.log(`Solariun API listening on http://localhost:${env.port} (${env.nodeEnv})`);
});

// Render (and most hosts) send SIGTERM on every deploy. Finish the requests in flight, then close the database.
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log('info', 'shutting down', { signal });
  clearInterval(stopHousekeeping);
  const force = setTimeout(() => process.exit(1), 15000);
  force.unref();
  server.close(async () => {
    try { await pool.end(); } catch { /* already closed */ }
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log('error', 'unhandled promise rejection', { error: String(reason?.stack ?? reason).split('\n').slice(0, 6).join(' | ') }));
process.on('uncaughtException', (err) => { log('error', 'uncaught exception', { error: String(err?.stack ?? err).split('\n').slice(0, 6).join(' | ') }); shutdown('uncaughtException'); });
