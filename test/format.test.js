import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, api, sessionFor } from './helpers.js';
import { loadConfig } from '../src/config.js';

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

test('format charges a flat 1 credit even when the provider reports a cost', async (t) => {
  const stub = await stubProvider(t);
  const { base, db, cfg } = await startServer(t, { cfgOverrides: providerCfg(stub.url) });
  const { token } = sessionFor(db, cfg); // starter 10_000_000 = 1,000 credits

  const res = await api(base, 'POST', '/format', { token, body: { text: 'John chapter 3 verse 16' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.result, 'JHN.3.16');
  // Provider reported usage.cost 0.0015 USD, but the charge is the flat
  // 1 credit = 10,000 micros, NOT the provider cost.
  assert.equal(res.json.chargedMicros, 10_000);
  assert.equal(res.json.balanceMicros, 10_000_000 - 10_000);
  assert.equal(stub.state.requests.length, 1);
  assert.match(stub.state.requests[0].messages[0].content, /John chapter 3 verse 16/);
});

test('format charges a flat 1 credit when the provider reports no cost', async (t) => {
  const stub = await stubProvider(t);
  stub.state.mode = 'flat';
  const { base, db, cfg } = await startServer(t, { cfgOverrides: providerCfg(stub.url) });
  const { token } = sessionFor(db, cfg);

  const res = await api(base, 'POST', '/format', { token, body: { text: 'Romans 8 28' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.chargedMicros, 10_000); // 1 credit
  assert.equal(res.json.balanceMicros, 10_000_000 - 10_000);
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
    // Balance exactly equals one 1-credit reserve: a leaked hold would
    // block the retry.
    cfgOverrides: providerCfg(stub.url, { starterGrantMicros: 10_000 }),
  });
  const { token } = sessionFor(db, cfg);

  const failed = await api(base, 'POST', '/format', { token, body: { text: 'John 3 16' } });
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error, 'provider_error');

  stub.state.mode = 'flat';
  const retry = await api(base, 'POST', '/format', { token, body: { text: 'John 3 16' } });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.balanceMicros, 10_000 - 10_000);
});

test('per-user daily cap returns 429 once projected spend passes it', async (t) => {
  const stub = await stubProvider(t);
  stub.state.mode = 'flat';
  const { base, db, cfg } = await startServer(t, {
    // After one 1-credit (10_000) charge, a second 10_000 reserve projects
    // to 20_000 > 19_999.
    cfgOverrides: providerCfg(stub.url, { userDailyCapMicros: 19_999 }),
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
    cfgOverrides: providerCfg(stub.url, { globalDailyCapMicros: 19_999 }),
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

test('config defaults express the credits model', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.formatChargeMicros, 10_000); // 1 credit per format call
  assert.equal(cfg.starterGrantMicros, 10_000_000); // 1,000 starter credits
  assert.equal(cfg.userDailyCapMicros, 2_500_000); // 250 credits/day
  assert.equal(cfg.globalDailyCapMicros, 50_000_000); // 5,000 credits/day
  // The $0.99 pack grants 15,000 credits = 150,000,000 micros.
  const withPack = loadConfig({ PRODUCT_CREDITS_JSON: '{"credits_099":150000000}' });
  assert.equal(withPack.productCredits.credits_099, 150_000_000);
});

test('a 10-credit balance buys exactly 10 format calls, then 402', async (t) => {
  const stub = await stubProvider(t);
  stub.state.mode = 'flat';
  const { base, db, cfg } = await startServer(t, {
    // Pin a small balance explicitly: the production starter grant is
    // 1,000 credits, far too many to exhaust in one test.
    cfgOverrides: providerCfg(stub.url, { starterGrantMicros: 100_000 }),
  });
  const { token } = sessionFor(db, cfg); // 100_000 micros = 10 credits

  for (let i = 1; i <= 10; i++) {
    const res = await api(base, 'POST', '/format', { token, body: { text: 'John 3 16' } });
    assert.equal(res.status, 200, `call ${i}`);
    assert.equal(res.json.chargedMicros, 10_000);
    assert.equal(res.json.balanceMicros, 100_000 - i * 10_000);
  }
  const eleventh = await api(base, 'POST', '/format', { token, body: { text: 'John 3 16' } });
  assert.equal(eleventh.status, 402);
  assert.equal(eleventh.json.error, 'insufficient_credits');
  assert.equal(stub.state.requests.length, 10); // the 402 never reached the provider
});
