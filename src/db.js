import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * SQLite persistence (better-sqlite3, synchronous). Single process, so a
 * check-then-write inside one transaction cannot interleave with another
 * request's synchronous section.
 *
 * Money is integer microdollars. The ledger is append-only; users.balance_micros
 * is a cached balance updated in the SAME transaction as every ledger insert.
 *
 * Format-call flow uses reservations: reserve() checks balance + daily caps
 * and records an outstanding hold; settle() converts the hold into a
 * 'format_charge' ledger entry for the actual cost. Holds live in their own
 * table (they are not ledger entries until settled).
 */

export function dayStartUtcMs(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'aura.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_sub TEXT NOT NULL UNIQUE,
      email TEXT,
      balance_micros INTEGER NOT NULL DEFAULT 0,
      starter_granted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount_micros INTEGER NOT NULL,
      ref TEXT,
      meta TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON ledger(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_time ON ledger(created_at);
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      product_id TEXT NOT NULL,
      purchase_token TEXT NOT NULL UNIQUE,
      order_id TEXT,
      granted_micros INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount_micros INTEGER NOT NULL,
      settled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reservations_user ON reservations(user_id, settled);
  `);
  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
  }

  _applyLedger(userId, type, amountMicros, { ref = null, meta = null } = {}, now) {
    const user = this.db.prepare('SELECT balance_micros FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error(`_applyLedger: no user ${userId}`);
    const newBalance = user.balance_micros + amountMicros;
    this.db.prepare('UPDATE users SET balance_micros = ? WHERE id = ?').run(newBalance, userId);
    this.db
      .prepare('INSERT INTO ledger (user_id, type, amount_micros, ref, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, type, amountMicros, ref, meta === null ? null : JSON.stringify(meta), now);
    return newBalance;
  }

  /** Find-or-create by Google sub. A new user gets the starter grant
   *  exactly once, in the same transaction that creates the user. */
  findOrCreateUser(googleSub, email, starterMicros, now) {
    const existing = this.db.prepare('SELECT * FROM users WHERE google_sub = ?').get(googleSub);
    if (existing) {
      if (email && email !== existing.email) {
        this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, existing.id);
        existing.email = email;
      }
      return { user: existing, isNewUser: false };
    }
    const create = this.db.transaction(() => {
      const info = this.db
        .prepare('INSERT INTO users (google_sub, email, balance_micros, starter_granted, created_at) VALUES (?, ?, 0, 0, ?)')
        .run(googleSub, email, now);
      const userId = Number(info.lastInsertRowid);
      if (starterMicros > 0) {
        this._applyLedger(userId, 'starter_grant', starterMicros, { ref: 'signup' }, now);
        this.db.prepare('UPDATE users SET starter_granted = 1 WHERE id = ?').run(userId);
      }
      return this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    });
    return { user: create.immediate(), isNewUser: true };
  }

  getUser(userId) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
  }

  getPurchaseByToken(purchaseToken) {
    return this.db.prepare('SELECT * FROM purchases WHERE purchase_token = ?').get(purchaseToken) || null;
  }

  /** Grant a verified purchase exactly once. The UNIQUE(purchase_token)
   *  constraint is the idempotency guard. Returns { granted, balanceMicros }. */
  grantPurchase(userId, { productId, purchaseToken, orderId, amountMicros }, now) {
    const grant = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO purchases (user_id, product_id, purchase_token, order_id, granted_micros, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, productId, purchaseToken, orderId, amountMicros, now);
      const balanceMicros = this._applyLedger(userId, 'purchase_grant', amountMicros, { ref: orderId, meta: { productId } }, now);
      return { granted: true, balanceMicros };
    });
    try {
      return grant.immediate();
    } catch (e) {
      if (String(e.code || '').startsWith('SQLITE_CONSTRAINT')) {
        const user = this.getUser(userId);
        return { granted: false, alreadyGranted: true, balanceMicros: user ? user.balance_micros : 0 };
      }
      throw e;
    }
  }

  /** Settled format spend (positive micros) since `sinceMs`; userId null = global. */
  _formatSpendSince(userId, sinceMs) {
    const row = userId === null
      ? this.db.prepare("SELECT COALESCE(-SUM(amount_micros), 0) AS spent FROM ledger WHERE type = 'format_charge' AND created_at >= ?").get(sinceMs)
      : this.db.prepare("SELECT COALESCE(-SUM(amount_micros), 0) AS spent FROM ledger WHERE type = 'format_charge' AND user_id = ? AND created_at >= ?").get(userId, sinceMs);
    return row.spent;
  }

  _outstandingHolds(userId) {
    const row = userId === null
      ? this.db.prepare('SELECT COALESCE(SUM(amount_micros), 0) AS held FROM reservations WHERE settled = 0').get()
      : this.db.prepare('SELECT COALESCE(SUM(amount_micros), 0) AS held FROM reservations WHERE settled = 0 AND user_id = ?').get(userId);
    return row.held;
  }

  /**
   * Atomically check balance + daily caps and place a hold.
   * Returns { ok:true, reservationId } or { ok:false, reason } where
   * reason is 'insufficient' | 'user_cap' | 'global_cap'.
   */
  reserve(userId, amountMicros, { userCapMicros, globalCapMicros }, now) {
    const attempt = this.db.transaction(() => {
      const user = this.db.prepare('SELECT balance_micros FROM users WHERE id = ?').get(userId);
      if (!user) return { ok: false, reason: 'insufficient' };
      const available = user.balance_micros - this._outstandingHolds(userId);
      if (available < amountMicros) return { ok: false, reason: 'insufficient' };
      const dayStart = dayStartUtcMs(now);
      const userProjected = this._formatSpendSince(userId, dayStart) + this._outstandingHolds(userId) + amountMicros;
      if (userProjected > userCapMicros) return { ok: false, reason: 'user_cap' };
      const globalProjected = this._formatSpendSince(null, dayStart) + this._outstandingHolds(null) + amountMicros;
      if (globalProjected > globalCapMicros) return { ok: false, reason: 'global_cap' };
      const reservationId = crypto.randomUUID();
      this.db
        .prepare('INSERT INTO reservations (id, user_id, amount_micros, settled, created_at) VALUES (?, ?, ?, 0, ?)')
        .run(reservationId, userId, amountMicros, now);
      return { ok: true, reservationId };
    });
    return attempt.immediate();
  }

  /**
   * Convert a hold into a format_charge for the actual cost. The charge is
   * floored so the balance never drops below -floorBelowZeroMicros (the
   * reserve amount): if the provider reports a cost higher than the user's
   * balance plus that floor, we under-collect and flag the discrepancy.
   * Returns { chargedMicros, balanceMicros, discrepancy }.
   */
  settle(reservationId, actualMicros, usageMeta, floorBelowZeroMicros, now) {
    const run = this.db.transaction(() => {
      const hold = this.db.prepare('SELECT * FROM reservations WHERE id = ? AND settled = 0').get(reservationId);
      if (!hold) throw new Error(`settle: no open reservation ${reservationId}`);
      this.db.prepare('UPDATE reservations SET settled = 1 WHERE id = ?').run(reservationId);
      const user = this.db.prepare('SELECT balance_micros FROM users WHERE id = ?').get(hold.user_id);
      const maxCharge = Math.max(0, user.balance_micros + floorBelowZeroMicros);
      const charged = Math.max(0, Math.min(actualMicros, maxCharge));
      const balanceMicros = this._applyLedger(hold.user_id, 'format_charge', -charged, { ref: reservationId, meta: usageMeta }, now);
      return { chargedMicros: charged, balanceMicros, discrepancy: charged !== actualMicros };
    });
    return run.immediate();
  }

  /** Release a hold without charging (provider call failed). */
  cancelReservation(reservationId) {
    this.db.prepare('DELETE FROM reservations WHERE id = ? AND settled = 0').run(reservationId);
  }

  /** Google Play account-deletion requirement: remove the user and all of
   *  their ledger, purchase, and reservation rows. */
  deleteUser(userId) {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM reservations WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM purchases WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM ledger WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });
    run.immediate();
  }
}
