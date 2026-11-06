import crypto from 'node:crypto';

/** Minimal JWT helpers: HS256 sign/verify for our own session tokens,
 *  plus shared base64url plumbing used by the Google/Play verifiers. */

export function b64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

export function b64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

export function signHs256(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const signingInput = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64urlEncode(sig)}`;
}

function invalid(message) {
  const err = new Error(message);
  err.status = 401;
  err.error = 'invalid_token';
  return err;
}

export function verifyHs256(token, secret) {
  if (typeof token !== 'string') throw invalid('Malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    throw invalid('Malformed token');
  }
  if (header.alg !== 'HS256') throw invalid('Unexpected token algorithm');
  const expected = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const actual = b64urlDecode(sigB64);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw invalid('Bad token signature');
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
    throw invalid('Token expired');
  }
  return payload;
}
