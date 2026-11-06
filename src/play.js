import crypto from 'node:crypto';
import { b64urlEncode } from './jwt.js';

/**
 * Google Play Developer API purchase verification (androidpublisher v3).
 * Auth: service-account JWT grant built with node:crypto, exchanged at
 * Google's OAuth2 token endpoint for an access token (cached).
 * Returns null from the factory when Play is not configured.
 */
export function createPlayVerifier(cfg, fetchImpl = fetch) {
  if (!cfg.playPackageName || !cfg.googleServiceAccountJson) return null;
  let sa;
  try {
    sa = JSON.parse(cfg.googleServiceAccountJson);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key');
  }

  let cached = null; // { accessToken, expiresAtMs }

  async function accessToken() {
    if (cached && cached.expiresAtMs > Date.now() + 60_000) return cached.accessToken;
    const nowSec = Math.floor(Date.now() / 1000);
    const header = b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64urlEncode(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: cfg.playTokenUrl,
      iat: nowSec,
      exp: nowSec + 3600,
    }));
    const signingInput = `${header}.${claims}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    const jwt = `${signingInput}.${signer.sign(sa.private_key).toString('base64url')}`;

    const res = await fetchImpl(cfg.playTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    if (!res.ok) throw new Error(`Play OAuth token exchange failed: HTTP ${res.status}`);
    const data = await res.json();
    cached = { accessToken: data.access_token, expiresAtMs: Date.now() + data.expires_in * 1000 };
    return cached.accessToken;
  }

  return {
    /**
     * Resolves to the raw purchases.products.get resource:
     * { purchaseState, orderId, obfuscatedExternalAccountId, ... }
     * purchaseState: 0 = purchased, 1 = canceled, 2 = pending.
     */
    async getProductPurchase(productId, purchaseToken) {
      const token = await accessToken();
      const url = `${cfg.playApiBase}/androidpublisher/v3/applications/`
        + `${encodeURIComponent(cfg.playPackageName)}/purchases/products/`
        + `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 404 || res.status === 410) {
        const err = new Error('Play does not recognize this purchase token');
        err.status = 404;
        err.error = 'purchase_not_found';
        throw err;
      }
      if (!res.ok) throw new Error(`Play purchase verification failed: HTTP ${res.status}`);
      return res.json();
    },
  };
}
