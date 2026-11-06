import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-ledger-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return openDb(dir);
}

function ledgerCount(db, userId, type) {
  return db.db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND type = ?').get(userId, type).n;
}

test('starter grant is applied exactly once', (t) => {
  const db = tempDb(t);
  const now = Date.now();
  const first = db.findOrCreateUser('sub-1', 'a@example.com', 100_000, now);
  assert.equal(first.isNewUser, true);
  assert.equal(first.user.balance_micros, 100_000);
  assert.equal(ledgerCount(db, first.user.id, 'starter_grant'), 1);

  const second = db.findOrCreateUser('sub-1', 'a@example.com', 100_000, now);
  assert.equal(second.isNewUser, false);
  assert.equal(second.user.balance_micros, 100_000);
  assert.equal(ledgerCount(db, first.user.id, 'starter_grant'), 1);
});

test('purchase grant is idempotent at the db layer', (t) => {
  const db = tempDb(t);
  const { user } = db.findOrCreateUser('sub-2', null, 0, Date.now());
  const purchase = { productId: 'credits_099', purchaseToken: 'tok-abc', orderId: 'GPA.1', amountMicros: 1_000_000 };

  const first = db.grantPurchase(user.id, purchase, Date.now());
  assert.equal(first.granted, true);
  assert.equal(first.balanceMicros, 1_000_000);

  const replay = db.grantPurchase(user.id, purchase, Date.now());
  assert.equal(replay.granted, false);
  assert.equal(replay.alreadyGranted, true);
  assert.equal(replay.balanceMicros, 1_000_000);
  assert.equal(ledgerCount(db, user.id, 'purchase_grant'), 1);
});

test('reserve checks available balance including outstanding holds', (t) => {
  const db = tempDb(t);
  const caps = { userCapMicros: 10_000_000, globalCapMicros: 10_000_000 };
  const { user } = db.findOrCreateUser('sub-3', null, 100_000, Date.now());

  const r1 = db.reserve(user.id, 5_000, caps, Date.now());
  assert.equal(r1.ok, true);

  const tooBig = db.reserve(user.id, 96_000, caps, Date.now());
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.reason, 'insufficient');

  const settled = db.settle(r1.reservationId, 1_500, { prompt_tokens: 10 }, 5_000, Date.now());
  assert.equal(settled.chargedMicros, 1_500);
  assert.equal(settled.balanceMicros, 98_500);
  assert.equal(settled.discrepancy, false);

  // The settled hold no longer counts against availability.
  const r2 = db.reserve(user.id, 96_000, caps, Date.now());
  assert.equal(r2.ok, true);
});

test('settle floors the balance at -reserve and flags the discrepancy', (t) => {
  const db = tempDb(t);
  const caps = { userCapMicros: 10_000_000, globalCapMicros: 10_000_000 };
  const { user } = db.findOrCreateUser('sub-4', null, 5_000, Date.now());
  const r = db.reserve(user.id, 5_000, caps, Date.now());
  assert.equal(r.ok, true);

  const settled = db.settle(r.reservationId, 999_999, null, 5_000, Date.now());
  assert.equal(settled.chargedMicros, 10_000); // balance 5000 + floor 5000
  assert.equal(settled.balanceMicros, -5_000);
  assert.equal(settled.discrepancy, true);
});

test('cancelReservation releases the hold', (t) => {
  const db = tempDb(t);
  const caps = { userCapMicros: 10_000_000, globalCapMicros: 10_000_000 };
  const { user } = db.findOrCreateUser('sub-5', null, 5_000, Date.now());
  const r = db.reserve(user.id, 5_000, caps, Date.now());
  assert.equal(r.ok, true);
  db.cancelReservation(r.reservationId);
  const again = db.reserve(user.id, 5_000, caps, Date.now());
  assert.equal(again.ok, true);
});

test('deleteUser removes user, ledger, purchases, reservations', (t) => {
  const db = tempDb(t);
  const caps = { userCapMicros: 10_000_000, globalCapMicros: 10_000_000 };
  const { user } = db.findOrCreateUser('sub-6', null, 100_000, Date.now());
  db.grantPurchase(user.id, { productId: 'credits_099', purchaseToken: 'tok-del', orderId: 'GPA.9', amountMicros: 500 }, Date.now());
  db.reserve(user.id, 5_000, caps, Date.now());

  db.deleteUser(user.id);
  assert.equal(db.getUser(user.id), null);
  assert.equal(db.getPurchaseByToken('tok-del'), null);
  for (const table of ['ledger', 'purchases', 'reservations']) {
    const row = db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(user.id);
    assert.equal(row.n, 0, `${table} should be empty for deleted user`);
  }
});
