import { env } from './config/env.js';
import { createApp } from './app.js';

const app = createApp();
app.listen(env.port, () => {
  console.log(`Sunledger API listening on http://localhost:${env.port} (${env.nodeEnv})`);
});
