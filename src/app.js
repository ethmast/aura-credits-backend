import http from 'node:http';
import { signHs256, verifyHs256 } from './jwt.js';
import { createGoogleVerifier } from './google.js';
import { createPlayVerifier } from './play.js';
import { createProvider } from './provider.js';

/**
 * HTTP routing for the credits API. Dependencies (db, verifiers, provider)
 * are injectable so tests can stub Google/Play/the AI provider without
 * real network calls.
 *
 * Error contract: every error response is JSON { error: string }.
 * Nothing here logs tokens, keys, or request bodies.
 */

function httpError(status, error) {
  const err = new Error(error);
  err.status = status;
  err.error = error;
  return err;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(httpError(413, 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp({ cfg, db, googleVerifier, playVerifier, provider }) {
  const google = googleVerifier !== undefined ? googleVerifier : createGoogleVerifier(cfg);
  const play = playVerifier !== undefined ? playVerifier : createPlayVerifier(cfg);
  const ai = provider !== undefined ? provider : createProvider(cfg);

  function requireSession(req) {
    const header = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(header);
    if (!m) throw httpError(401, 'unauthorized');
    const payload = verifyHs256(m[1], cfg.sessionSecret); // throws 401 invalid_token
    const user = db.getUser(Number(payload.sub));
    if (!user) throw httpError(401, 'unauthorized');
    return user;
  }

  async function handleAuthGoogle(req, res) {
    const body = await readBody(req, cfg.maxBodyBytes);
    if (!body.idToken || typeof body.idToken !== 'string') throw httpError(400, 'missing_id_token');
    const claims = await google.verifyIdToken(body.idToken);
    const { user, isNewUser } = db.findOrCreateUser(claims.sub, claims.email, cfg.starterGrantMicros, Date.now());
    const sessionToken = signHs256({ sub: user.id }, cfg.sessionSecret, cfg.sessionTtlSeconds);
    sendJson(res, 200, { sessionToken, balanceMicros: user.balance_micros, isNewUser });
  }

  async function handlePurchaseVerify(req, res, user) {
    const body = await readBody(req, cfg.maxBodyBytes);
    const { productId, purchaseToken } = body;
    if (!productId || typeof productId !== 'string' || !purchaseToken || typeof purchaseToken !== 'string') {
      throw httpError(400, 'missing_product_or_token');
    }
    const amountMicros = cfg.productCredits[productId];
    if (amountMicros === undefined) throw httpError(400, 'unknown_product');
    if (!play) throw httpError(503, 'purchases_not_configured');

    const existing = db.getPurchaseByToken(purchaseToken);
    if (existing) {
      if (existing.user_id !== user.id) throw httpError(409, 'purchase_token_already_used');
      return sendJson(res, 200, { granted: false, alreadyGranted: true, balanceMicros: user.balance_micros });
    }

    const purchase = await play.getProductPurchase(productId, purchaseToken);
    if (purchase.purchaseState !== 0) throw httpError(400, 'purchase_not_completed');
    if (purchase.obfuscatedExternalAccountId
        && purchase.obfuscatedExternalAccountId !== String(user.id)) {
      throw httpError(403, 'purchase_account_mismatch');
    }

    const result = db.grantPurchase(user.id, {
      productId,
      purchaseToken,
      orderId: purchase.orderId || null,
      amountMicros,
    }, Date.now());
    if (!result.granted) {
      return sendJson(res, 200, { granted: false, alreadyGranted: true, balanceMicros: result.balanceMicros });
    }
    sendJson(res, 200, { granted: true, grantedMicros: amountMicros, balanceMicros: result.balanceMicros });
  }

  async function handleFormat(req, res, user) {
    const body = await readBody(req, cfg.maxBodyBytes);
    const text = body.text;
    if (typeof text !== 'string' || text.trim() === '' || text.length > cfg.maxFormatChars) {
      throw httpError(400, 'invalid_text');
    }
    if (!ai) throw httpError(503, 'provider_not_configured');

    const reserve = db.reserve(user.id, cfg.formatChargeMicros, {
      userCapMicros: cfg.userDailyCapMicros,
      globalCapMicros: cfg.globalDailyCapMicros,
    }, Date.now());
    if (!reserve.ok) {
      if (reserve.reason === 'insufficient') throw httpError(402, 'insufficient_credits');
      throw httpError(429, reserve.reason === 'user_cap' ? 'user_daily_cap_exceeded' : 'global_daily_cap_exceeded');
    }

    let outcome;
    try {
      outcome = await ai.format(text);
    } catch (e) {
      db.cancelReservation(reserve.reservationId);
      throw e;
    }

    // Credits model: a successful format call costs a flat 1 credit
    // (formatChargeMicros), regardless of the provider's own reported
    // cost — that cost is kept only as usage metadata on the ledger entry.
    const settled = db.settle(reserve.reservationId, cfg.formatChargeMicros, outcome.usage, cfg.formatChargeMicros, Date.now());
    if (settled.discrepancy) {
      // Amounts only — never the text, tokens, or keys.
      console.error(`format settle discrepancy user=${user.id} expected=${cfg.formatChargeMicros} charged=${settled.chargedMicros}`);
    }
    sendJson(res, 200, { result: outcome.result, balanceMicros: settled.balanceMicros, chargedMicros: settled.chargedMicros });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /health':
          return sendJson(res, 200, { ok: true });
        case 'POST /auth/google':
          return await handleAuthGoogle(req, res);
        case 'GET /balance': {
          const user = requireSession(req);
          return sendJson(res, 200, { balanceMicros: user.balance_micros });
        }
        case 'POST /purchase/verify': {
          const user = requireSession(req);
          return await handlePurchaseVerify(req, res, user);
        }
        case 'POST /format': {
          const user = requireSession(req);
          return await handleFormat(req, res, user);
        }
        case 'POST /account/delete': {
          const user = requireSession(req);
          db.deleteUser(user.id);
          return sendJson(res, 200, { deleted: true });
        }
        default:
          throw httpError(404, 'not_found');
      }
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : 500;
      const error = typeof e.error === 'string' ? e.error : 'internal_error';
      if (status >= 500 && error === 'internal_error') console.error('internal error:', e.message);
      if (!res.headersSent) sendJson(res, status, { error });
    }
  });
  return server;
}
