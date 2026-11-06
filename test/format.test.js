import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, api, sessionFor } from './helpers.js';

/** Local stub of an OpenAI-compatible provider. Behavior is switchable:
 *  'cost' reports usage.cost, 'flat' reports token usage only, 'fail' 500s. */
function stubProvider(t) {
  const state = { mode: 'cost', requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.requests.push(JSON.parse(raw || '{}'));
      if (state.mode === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'boom' }));
      }
      const usage = state.mode === 'cost'
        ? { prompt_tokens: 120, completion_tokens: 8, cost: 0.0015 }
        : { prompt_tokens: 120, completion_tokens: 8 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'JHN.3.16' } }], usage }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({ state, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function providerCfg(url, extra = {}) {
  return { providerBaseUrl: url, providerApiKey: 'sk-test', providerModel: 'test-model', ...extra };
}

test('health is public and fast-path simple', async (t) => {
  const { base } = await startServer(t);
  const res = await api(base, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
});

test('format settles at provider-reported cost when available', async (t) => {
  const stub = await stubProvider(t);
  const { base, db, cfg } = await startServer(t, { cfgOverrides: providerCfg(stub.url) });
  const { token } = sessionFor(db, cfg); // starter 100_000

  const res = await api(base, 'POST', '/format', { token, body: { text: 'John chapter 3 verse 16' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.result, 'JHN.3.16');
  assert.equal(res.json.chargedMicros, 1500); // usage.cost 0.0015 USD
  assert.equal(res.json.balanceMicros, 100_000 - 1500);
  assert.equal(stub.state.requests.length, 1);
  assert.match(stub.state.requests[0].messages[0].content, /John chapter 3 verse 16/);
});

test('format falls back to the flat rate when the provider reports no cost', async (t) => {
  const stub = await stubProvider(t);
  stub.state.mode = 'flat';
  const { base, db, cfg } = await startServer(t, { cfgOverrides: providerCfg(stub.url) });
  const { token } = sessionFor(db, cfg);

  const res = await api(base, 'POST', '/format', { token, body: { text: 'Romans 8 28' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.chargedMicros, 1000); // FORMAT_FLAT_MICROS default
  assert.equal(res.json.balanceMicros, 100_000 - 1000);
});

test('insufficient balance is a 402 and never reaches the provider', async (t) => {
  const stub = await stubProvider(t);
  const { base, db, cfg } = await startServer(t, {
    cfgOverrides: providerCfg(stub.url, { starterGrantMicros: 0 }),
  });
  const { token } = sessionFor(db, cfg);

  const res = await api(base, 'POST', '/format', { token, body: { text: 'John 3 16' } });
  assert.equal(res.status, 402);
  assert.equal(res.json.error, 'insufficient_credits');
  assert.equal(stub.state.requests.length, 0);
});

test('provider failure releases the reservation', async (t) => {
  const stub = await stubProvider(t);
  stub.state.mode = 'fail';
  const { base, db, cfg } = await startServer(t, {
    // Balance exactly equals one reserve: a leaked hold would block the retry.
    cfgOverrides: providerCfg(stub.url, { starterGrantMicros: 5_000 }),
  });
  const { token } = sessionFor(db, cfg);

  const failed = await api(base, 'POST', '/format', { token, body: { text: 'John 3 16' } });
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error, 'provider_error');

  stub.state.mode = 'flat';
  const retry = await api(base, 'POST', '/format', { token, body: { text: 'John 3 16' } });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.balanceMicros, 5_000 - 1000);
});

test('per-user daily cap returns 429 once projected spend passes it', async (t) => {
  const stub = await stubProvider(t);
  stub.state.mode = 'flat';
  const { base, db, cfg } = await startServer(t, {
    // After one flat 1000 charge, a second 5000 reserve projects to 6000 > 5999.
    cfgOverrides: providerCfg(stub.url, { userDailyCapMicros: 5_999 }),
  });
  const { token } = sessionFor(db, cfg);

  const first = await api(base, 'POST', '/format', { token, body: { text: 'John 3 16' } });
  assert.equal(first.status, 200);
  const second = await api(base, 'POST', '/format', { token, body: { text: 'John 3 17' } });
  assert.equal(second.status, 429);
  assert.equal(second.json.error, 'user_daily_cap_exceeded');
});

test('global daily cap applies across users', async (t) => {
  const stub = await stubProvider(t);
  stub.state.mode = 'flat';
  const { base, db, cfg } = await startServer(t, {
    cfgOverrides: providerCfg(stub.url, { globalDailyCapMicros: 5_999 }),
  });
  const alice = sessionFor(db, cfg, 'alice-sub');
  const bob = sessionFor(db, cfg, 'bob-sub');

  const first = await api(base, 'POST', '/format', { token: alice.token, body: { text: 'John 3 16' } });
  assert.equal(first.status, 200);
  const second = await api(base, 'POST', '/format', { token: bob.token, body: { text: 'John 3 16' } });
  assert.equal(second.status, 429);
  assert.equal(second.json.error, 'global_daily_cap_exceeded');
});

test('text validation: empty and over-500-char inputs are 400', async (t) => {
  const stub = await stubProvider(t);
  const { base, db, cfg } = await startServer(t, { cfgOverrides: providerCfg(stub.url) });
  const { token } = sessionFor(db, cfg);

  const empty = await api(base, 'POST', '/format', { token, body: { text: '   ' } });
  assert.equal(empty.status, 400);
  const long = await api(base, 'POST', '/format', { token, body: { text: 'x'.repeat(501) } });
  assert.equal(long.status, 400);
  assert.equal(stub.state.requests.length, 0);
});

test('account delete removes the user and their session stops working', async (t) => {
  const { base, db, cfg } = await startServer(t);
  const { user, token } = sessionFor(db, cfg);

  const del = await api(base, 'POST', '/account/delete', { token });
  assert.equal(del.status, 200);
  assert.deepEqual(del.json, { deleted: true });
  assert.equal(db.getUser(user.id), null);

  const bal = await api(base, 'GET', '/balance', { token });
  assert.equal(bal.status, 401);
});
