/**
 * All configuration comes from environment variables. Money is integer
 * microdollars everywhere (1 USD = 1,000,000 micros); no floats for money
 * anywhere past this file.
 */

function str(env, name, fallback) {
  const v = env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(env, name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Env ${name} must be an integer, got: ${v}`);
  return n;
}

function parseProductCredits(env) {
  const raw = str(env, 'PRODUCT_CREDITS_JSON', '{}');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PRODUCT_CREDITS_JSON is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PRODUCT_CREDITS_JSON must be a JSON object mapping productId -> credit micros');
  }
  const map = {};
  for (const [productId, micros] of Object.entries(parsed)) {
    if (!Number.isInteger(micros) || micros <= 0) {
      throw new Error(`PRODUCT_CREDITS_JSON: value for "${productId}" must be a positive integer (microdollars)`);
    }
    map[productId] = micros;
  }
  return map;
}

export function loadConfig(env = process.env) {
  return {
    host: str(env, 'HOST', '0.0.0.0'),
    port: int(env, 'PORT', 8080),
    dataDir: str(env, 'DATA_DIR', './data'),

    googleWebClientId: str(env, 'GOOGLE_WEB_CLIENT_ID', ''),
    googleJwksUrl: str(env, 'GOOGLE_JWKS_URL', 'https://www.googleapis.com/oauth2/v3/certs'),

    // If empty, server.js generates an ephemeral secret at boot (sessions
    // die on restart). Set a stable value in production.
    sessionSecret: str(env, 'SESSION_SECRET', ''),
    sessionTtlSeconds: int(env, 'SESSION_TTL_DAYS', 30) * 24 * 60 * 60,

    starterGrantMicros: int(env, 'STARTER_GRANT_MICROS', 100_000),

    providerBaseUrl: str(env, 'PROVIDER_BASE_URL', '').replace(/\/+$/, ''),
    providerApiKey: str(env, 'PROVIDER_API_KEY', ''),
    providerModel: str(env, 'PROVIDER_MODEL', ''),
    providerTimeoutMs: int(env, 'PROVIDER_TIMEOUT_MS', 20_000),

    formatReserveMicros: int(env, 'FORMAT_RESERVE_MICROS', 5_000),
    formatFlatMicros: int(env, 'FORMAT_FLAT_MICROS', 1_000),
    userDailyCapMicros: int(env, 'USER_DAILY_CAP_MICROS', 200_000),
    globalDailyCapMicros: int(env, 'GLOBAL_DAILY_CAP_MICROS', 2_000_000),

    playPackageName: str(env, 'PLAY_PACKAGE_NAME', ''),
    googleServiceAccountJson: str(env, 'GOOGLE_SERVICE_ACCOUNT_JSON', ''),
    playTokenUrl: str(env, 'PLAY_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    playApiBase: str(env, 'PLAY_API_BASE', 'https://androidpublisher.googleapis.com'),
    productCredits: parseProductCredits(env),

    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 16_384),
    maxFormatChars: 500,
  };
}
