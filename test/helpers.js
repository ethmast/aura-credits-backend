import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { signHs256 } from '../src/jwt.js';

export function testConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-credits-test-'));
  const cfg = loadConfig({});
  Object.assign(cfg, {
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    sessionSecret: 'test-session-secret',
    starterGrantMicros: 100_000,
    googleWebClientId: 'test-web-client-id',
    productCredits: { credits_099: 1_000_000 },
  }, overrides);
  return cfg;
}

/** Starts an app on an ephemeral port. deps are passed through to
 *  createApp, so a test can stub googleVerifier / playVerifier / provider;
 *  anything not stubbed is built for real from cfg. */
export async function startServer(t, { cfgOverrides = {}, deps = {} } = {}) {
  const cfg = testConfig(cfgOverrides);
  const db = openDb(cfg.dataDir);
  const server = createApp({ cfg, db, ...deps });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(cfg.dataDir, { recursive: true, force: true });
  });
  return { base, db, cfg };
}

export async function api(base, method, route, { token, body } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

/** Creates a user directly in the db and returns a session token for them. */
export function sessionFor(db, cfg, googleSub = 'google-sub-1') {
  const { user } = db.findOrCreateUser(googleSub, 'user@example.com', cfg.starterGrantMicros, Date.now());
  const token = signHs256({ sub: user.id }, cfg.sessionSecret, 3600);
  return { user, token };
}
