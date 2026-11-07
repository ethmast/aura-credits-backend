import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { startServer, api } from './helpers.js';

/** Tombstones: the starter grant is once per GOOGLE ACCOUNT, surviving
 *  account deletion. The claim store holds only an HMAC hash of the sub. */

function stubGoogle(sub, email = 'tomb@example.com') {
  return { verifyIdToken: async () => ({ sub, email }) };
}

function claimCount(db) {
  return db.db.prepare('SELECT COUNT(*) AS n FROM starter_claims').get().n;
}

test('first sign-in grants the starter and records a hash-only claim', async (t) => {
  const { base, db } = await startServer(t, { deps: { googleVerifier: stubGoogle('tomb-sub-1') } });

  const res = await api(base, 'POST', '/auth/google', { body: { idToken: 'stubbed' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.isNewUser, true);
  assert.equal(res.json.balanceMicros, 10_000_000);

  assert.equal(db.hasStarterClaim('tomb-sub-1'), true);
  assert.equal(db.hasStarterClaim('someone-else'), false);
  assert.equal(claimCount(db), 1);

  // The tombstone is a one-way hash — the sub itself is not stored anywhere in it.
  const row = db.db.prepare('SELECT * FROM starter_claims').get();
  assert.match(row.claim_hash, /^[0-9a-f]{64}$/);
  assert.ok(!row.claim_hash.includes('tomb-sub-1'));
  assert.ok(row.granted_at > 0);
});

test('delete account, sign up again with the same Google account: no second starter', async (t) => {
  const { base, db } = await startServer(t, { deps: { googleVerifier: stubGoogle('tomb-sub-2') } });

  const first = await api(base, 'POST', '/auth/google', { body: { idToken: 'stubbed' } });
  assert.equal(first.json.balanceMicros, 10_000_000);
  const oldUser = db.db.prepare('SELECT * FROM users').get();

  const del = await api(base, 'POST', '/account/delete', { token: first.json.sessionToken });
  assert.equal(del.status, 200);
  assert.deepEqual(del.json, { deleted: true });

  // Deletion still removes the user and all of their data rows...
  assert.equal(db.getUser(oldUser.id), null);
  for (const table of ['ledger', 'purchases', 'reservations']) {
    const row = db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(oldUser.id);
    assert.equal(row.n, 0, `${table} should be empty for the deleted user`);
  }
  // ...but the tombstone survives.
  assert.equal(db.hasStarterClaim('tomb-sub-2'), true);
  assert.equal(claimCount(db), 1);

  // Re-sign-up: a new account is created, but with NO starter grant.
  const second = await api(base, 'POST', '/auth/google', { body: { idToken: 'stubbed' } });
  assert.equal(second.status, 200);
  assert.equal(second.json.isNewUser, true);
  assert.equal(second.json.balanceMicros, 0);

  const bal = await api(base, 'GET', '/balance', { token: second.json.sessionToken });
  assert.equal(bal.json.balanceMicros, 0);

  const newUser = db.db.prepare('SELECT * FROM users').get();
  assert.notEqual(newUser.id, oldUser.id);
  assert.equal(newUser.starter_granted, 0);
  const grants = db.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND type = 'starter_grant'").get(newUser.id);
  assert.equal(grants.n, 0);
  assert.equal(claimCount(db), 1); // still exactly one claim
});

test('backfill claims pre-existing grantees, is idempotent, and then enforces', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-tombstone-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openDb(dir); // no claim secret yet: legacy behavior, no claims written

  const { user } = db.findOrCreateUser('legacy-sub', 'legacy@example.com', 100_000, Date.now());
  assert.equal(user.balance_micros, 100_000);
  assert.equal(claimCount(db), 0);

  db.setClaimSecret('test-session-secret');
  assert.equal(db.backfillStarterClaims(), 1);
  assert.equal(db.hasStarterClaim('legacy-sub'), true);
  assert.equal(claimCount(db), 1);

  // Re-running the migration is a no-op.
  assert.equal(db.backfillStarterClaims(), 0);
  assert.equal(claimCount(db), 1);

  // The backfilled claim survives deletion and blocks a re-grant.
  db.deleteUser(user.id);
  assert.equal(db.hasStarterClaim('legacy-sub'), true);
  const again = db.findOrCreateUser('legacy-sub', 'legacy@example.com', 100_000, Date.now());
  assert.equal(again.isNewUser, true);
  assert.equal(again.user.balance_micros, 0);
  assert.equal(again.user.starter_granted, 0);
});

test('claims are per Google account: a different account still gets its starter', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-tombstone-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openDb(dir);
  db.setClaimSecret('test-session-secret');

  const a = db.findOrCreateUser('account-a', null, 50_000, Date.now());
  const b = db.findOrCreateUser('account-b', null, 50_000, Date.now());
  assert.equal(a.user.balance_micros, 50_000);
  assert.equal(b.user.balance_micros, 50_000);
  assert.equal(claimCount(db), 2);
});
