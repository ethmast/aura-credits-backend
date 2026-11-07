import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startServer, api } from './helpers.js';

/** Builds a Google-style RS256 ID token signed by a local test key, and a
 *  JWKS document for its public half — the real verifier must accept the
 *  good ones and reject tampered/expired/wrong-audience ones. */
function makeGooglePlayground(t) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-key-1';
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });

  const jwksServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });

  return new Promise((resolve) => {
    jwksServer.listen(0, '127.0.0.1', () => {
      t.after(() => jwksServer.close());
      const jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/certs`;

      function signIdToken(claims, { kid = 'test-key-1' } = {}) {
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
        const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(`${header}.${payload}`);
        const sig = signer.sign(privatePem).toString('base64url');
        return `${header}.${payload}.${sig}`;
      }

      function validClaims(overrides = {}) {
        const now = Math.floor(Date.now() / 1000);
        return {
          iss: 'https://accounts.google.com',
          aud: 'test-web-client-id',
          sub: 'google-user-42',
          email: 'user42@example.com',
          iat: now,
          exp: now + 3600,
          ...overrides,
        };
      }

      resolve({ jwksUrl, signIdToken, validClaims });
    });
  });
}

test('valid Google ID token creates the user, grants starter once, session works', async (t) => {
  const gp = await makeGooglePlayground(t);
  const { base } = await startServer(t, { cfgOverrides: { googleJwksUrl: gp.jwksUrl } });

  const idToken = gp.signIdToken(gp.validClaims());
  const first = await api(base, 'POST', '/auth/google', { body: { idToken } });
  assert.equal(first.status, 200);
  assert.equal(first.json.isNewUser, true);
  assert.equal(first.json.balanceMicros, 10_000_000);
  assert.ok(first.json.sessionToken);

  const bal = await api(base, 'GET', '/balance', { token: first.json.sessionToken });
  assert.equal(bal.status, 200);
  assert.equal(bal.json.balanceMicros, 10_000_000);

  const second = await api(base, 'POST', '/auth/google', { body: { idToken } });
  assert.equal(second.status, 200);
  assert.equal(second.json.isNewUser, false);
  assert.equal(second.json.balanceMicros, 10_000_000); // no second starter grant
});

test('tampered, expired, and wrong-audience tokens are rejected with 401', async (t) => {
  const gp = await makeGooglePlayground(t);
  const { base } = await startServer(t, { cfgOverrides: { googleJwksUrl: gp.jwksUrl } });

  // Tampered payload (signature no longer matches).
  const good = gp.signIdToken(gp.validClaims());
  const [h, , s] = good.split('.');
  const forgedPayload = Buffer.from(JSON.stringify(gp.validClaims({ sub: 'attacker' }))).toString('base64url');
  const tampered = await api(base, 'POST', '/auth/google', { body: { idToken: `${h}.${forgedPayload}.${s}` } });
  assert.equal(tampered.status, 401);
  assert.equal(tampered.json.error, 'invalid_token');

  // Expired.
  const now = Math.floor(Date.now() / 1000);
  const expired = gp.signIdToken(gp.validClaims({ iat: now - 7200, exp: now - 3600 }));
  const expiredRes = await api(base, 'POST', '/auth/google', { body: { idToken: expired } });
  assert.equal(expiredRes.status, 401);

  // Wrong audience.
  const wrongAud = gp.signIdToken(gp.validClaims({ aud: 'someone-elses-client' }));
  const wrongAudRes = await api(base, 'POST', '/auth/google', { body: { idToken: wrongAud } });
  assert.equal(wrongAudRes.status, 401);

  // Garbage.
  const garbage = await api(base, 'POST', '/auth/google', { body: { idToken: 'not-a-jwt' } });
  assert.equal(garbage.status, 401);
});

test('protected endpoints reject missing or bogus session tokens', async (t) => {
  const { base } = await startServer(t);
  const noToken = await api(base, 'GET', '/balance');
  assert.equal(noToken.status, 401);
  const bogus = await api(base, 'GET', '/balance', { token: 'aaa.bbb.ccc' });
  assert.equal(bogus.status, 401);
});
