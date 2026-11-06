import crypto from 'node:crypto';
import { b64urlDecode } from './jwt.js';

/**
 * Google ID-token verification, done properly (no tokeninfo shortcut):
 *  - fetch Google's JWKS, cached until its Cache-Control max-age expires
 *  - verify the RS256 signature against the key named by `kid`
 *  - check iss, aud (our web client id), and exp
 * fetch is injectable so tests can serve a local JWKS.
 */

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

function invalidToken(message) {
  const err = new Error(message);
  err.status = 401;
  err.error = 'invalid_token';
  return err;
}

export function createGoogleVerifier(cfg, fetchImpl = fetch) {
  let jwksCache = null; // { keysByKid: Map<string, KeyObject>, expiresAtMs }

  async function loadJwks(force = false) {
    if (!force && jwksCache && jwksCache.expiresAtMs > Date.now()) return jwksCache;
    const res = await fetchImpl(cfg.googleJwksUrl);
    if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
    const body = await res.json();
    const keysByKid = new Map();
    for (const jwk of body.keys || []) {
      if (jwk.kid && jwk.kty === 'RSA') {
        keysByKid.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
      }
    }
    let ttlMs = 3600_000;
    const cc = typeof res.headers?.get === 'function' ? res.headers.get('cache-control') : null;
    const m = cc && /max-age=(\d+)/.exec(cc);
    if (m) ttlMs = Number(m[1]) * 1000;
    jwksCache = { keysByKid, expiresAtMs: Date.now() + ttlMs };
    return jwksCache;
  }

  return {
    /** Resolves to { sub, email } or throws a 401 invalid_token error. */
    async verifyIdToken(idToken) {
      if (typeof idToken !== 'string') throw invalidToken('Missing ID token');
      const parts = idToken.split('.');
      if (parts.length !== 3) throw invalidToken('Malformed ID token');
      const [headerB64, payloadB64, sigB64] = parts;
      let header;
      let payload;
      try {
        header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
        payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
      } catch {
        throw invalidToken('Malformed ID token');
      }
      if (header.alg !== 'RS256' || !header.kid) throw invalidToken('Unexpected token header');

      let jwks = await loadJwks();
      let key = jwks.keysByKid.get(header.kid);
      if (!key) {
        jwks = await loadJwks(true); // key rotation: refetch once
        key = jwks.keysByKid.get(header.kid);
      }
      if (!key) throw invalidToken('Unknown signing key');

      const ok = crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${headerB64}.${payloadB64}`),
        key,
        b64urlDecode(sigB64),
      );
      if (!ok) throw invalidToken('Bad token signature');

      if (!ISSUERS.has(payload.iss)) throw invalidToken('Unexpected token issuer');
      if (payload.aud !== cfg.googleWebClientId) throw invalidToken('Token audience is not this app');
      if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
        throw invalidToken('Token expired');
      }
      if (!payload.sub) throw invalidToken('Token has no subject');
      return { sub: String(payload.sub), email: payload.email || null };
    },
  };
}
