import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const cfg = loadConfig();

if (!cfg.sessionSecret) {
  cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set: generated an ephemeral secret. Sessions will not survive restarts.');
}
if (!cfg.googleWebClientId) {
  console.warn('GOOGLE_WEB_CLIENT_ID is not set: /auth/google will reject all tokens.');
}

const db = openDb(cfg.dataDir);
const server = createApp({ cfg, db });
server.listen(cfg.port, cfg.host, () => {
  console.log(`aura-credits-backend listening on ${cfg.host}:${cfg.port}`);
});
