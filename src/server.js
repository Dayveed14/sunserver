import { env } from './config/env.js';
import { createApp } from './app.js';
import { adminService } from './modules/admin/index.js';

// Pick up any pricing changes an admin saved earlier. If the table is missing (db:init not run yet) carry on with defaults.
try {
  const { applied } = await adminService.loadSettings();
  if (applied) console.log(`[admin] loaded ${applied} saved pricing setting(s).`);
} catch (err) {
  console.warn('[admin] could not load saved pricing settings:', err.code ?? err.message);
}

const app = createApp();
app.listen(env.port, () => {
  console.log(`Sunledger API listening on http://localhost:${env.port} (${env.nodeEnv})`);
});
