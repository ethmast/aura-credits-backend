import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, sessionFor } from './helpers.js';

function playStub(purchasesByToken) {
  return {
    async getProductPurchase(productId, purchaseToken) {
      const found = purchasesByToken[purchaseToken];
      if (!found) {
        const err = new Error('not found');
        err.status = 404;
        err.error = 'purchase_not_found';
        throw err;
      }
      return found;
    },
  };
}

test('verified purchase grants once; replay is idempotent', async (t) => {
  const play = playStub({ 'tok-1': { purchaseState: 0, orderId: 'GPA.111' } });
  const { base, db, cfg } = await startServer(t, {
    cfgOverrides: { starterGrantMicros: 0 },
    deps: { playVerifier: play },
  });
  const { token } = sessionFor(db, cfg);

  const first = await api(base, 'POST', '/purchase/verify', { token, body: { productId: 'credits_099', purchaseToken: 'tok-1' } });
  assert.equal(first.status, 200);
  assert.equal(first.json.granted, true);
  assert.equal(first.json.grantedMicros, 150_000_000);
  assert.equal(first.json.balanceMicros, 150_000_000);

  const replay = await api(base, 'POST', '/purchase/verify', { token, body: { productId: 'credits_099', purchaseToken: 'tok-1' } });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.granted, false);
  assert.equal(replay.json.alreadyGranted, true);
  assert.equal(replay.json.balanceMicros, 150_000_000); // unchanged
});

test('uncompleted purchase and unknown product grant nothing', async (t) => {
  const play = playStub({ 'tok-pending': { purchaseState: 2, orderId: 'GPA.222' } });
  const { base, db, cfg } = await startServer(t, {
    cfgOverrides: { starterGrantMicros: 0 },
    deps: { playVerifier: play },
  });
  const { token } = sessionFor(db, cfg);

  const pending = await api(base, 'POST', '/purchase/verify', { token, body: { productId: 'credits_099', purchaseToken: 'tok-pending' } });
  assert.equal(pending.status, 400);
  assert.equal(pending.json.error, 'purchase_not_completed');

  const unknown = await api(base, 'POST', '/purchase/verify', { token, body: { productId: 'nope', purchaseToken: 'tok-pending' } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, 'unknown_product');

  const bal = await api(base, 'GET', '/balance', { token });
  assert.equal(bal.json.balanceMicros, 0);
});

test('purchase bound to another account is rejected; token reuse by another user conflicts', async (t) => {
  const play = playStub({
    'tok-mismatch': { purchaseState: 0, orderId: 'GPA.333', obfuscatedExternalAccountId: 'not-this-user' },
    'tok-shared': { purchaseState: 0, orderId: 'GPA.444' },
  });
  const { base, db, cfg } = await startServer(t, {
    cfgOverrides: { starterGrantMicros: 0 },
    deps: { playVerifier: play },
  });
  const alice = sessionFor(db, cfg, 'alice-sub');
  const bob = sessionFor(db, cfg, 'bob-sub');

  const mismatch = await api(base, 'POST', '/purchase/verify', { token: alice.token, body: { productId: 'credits_099', purchaseToken: 'tok-mismatch' } });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.json.error, 'purchase_account_mismatch');

  const granted = await api(base, 'POST', '/purchase/verify', { token: alice.token, body: { productId: 'credits_099', purchaseToken: 'tok-shared' } });
  assert.equal(granted.status, 200);
  assert.equal(granted.json.granted, true);

  const stolen = await api(base, 'POST', '/purchase/verify', { token: bob.token, body: { productId: 'credits_099', purchaseToken: 'tok-shared' } });
  assert.equal(stolen.status, 409);
  assert.equal(stolen.json.error, 'purchase_token_already_used');
});
