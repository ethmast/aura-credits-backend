# Aura Credits Backend

A small, production-shaped API that powers the optional **credits mode** in
Aura Verse Link (the alternative to bring-your-own-key). Users sign in with
Google, buy credit packs through Google Play Billing, and this service
spends from a ledger while calling an AI provider with the owner's
server-side key.

Designed to run on **Railway's Free plan**: one service, one SQLite file on
one mounted volume, tiny idle footprint, and no assumption that the process
stays warm — on Free, Serverless sleeping is forced, so the service sleeps
when idle and `/health` is the wake-up target (the Android app pings it
when a listening session starts, retries on a wake-up 502, and keeps the
service warm with light pings while listening).

## Architecture

- **Runtime:** Node.js 22, plain ESM, `node:http` (no framework). Only
  runtime dependency is `better-sqlite3` (prebuilt). Everything else —
  JWT signing/verification, Google JWKS verification, the Play service
  account grant — is `node:crypto` and stdlib.
- **Data:** SQLite at `$DATA_DIR/aura.db`. Append-only ledger
  (`starter_grant`, `purchase_grant`, `format_charge`); the user's balance
  is a cached column updated in the same transaction as each ledger
  insert. Format calls place a **reservation** (hold) of 1 credit first,
  then settle a flat 1-credit charge on success (a failed provider call
  releases the hold uncharged).
- **Money:** integer micros everywhere (1 credit = 10,000 micros). No
  floats for money.
- **Auth:** the app sends a Google ID token once; the backend verifies it
  against Google's JWKS (RS256 signature, issuer, audience, expiry) and
  issues its own HS256 session JWT (30-day expiry). All other endpoints
  take `Authorization: Bearer <sessionToken>`.
- **Purchases:** the client sends a Play purchase token; the backend
  verifies it with the Play Developer API and grants an amount taken
  **only** from the server-side product map. Grants are idempotent —
  a purchase token can never be granted twice.

## Endpoints

| Route | Auth | Description |
|---|---|---|
| `GET /health` | none | `{ok:true}`. Wake-up ping target; fast, no I/O. |
| `POST /auth/google` | none | `{idToken}` → `{sessionToken, balanceMicros, isNewUser}`. New users get the starter grant exactly once. |
| `GET /balance` | session | `{balanceMicros}` |
| `POST /purchase/verify` | session | `{productId, purchaseToken}` → grants credits after Play verification. Replay → `{granted:false, alreadyGranted:true, balanceMicros}`. |
| `POST /format` | session | `{text}` (≤500 chars) → `{result, balanceMicros, chargedMicros}`. 402 on insufficient credits, 429 on daily-cap. |
| `POST /account/delete` | session | Deletes the user and all their ledger/purchase/reservation rows. `{deleted:true}` |

All errors are JSON `{error: string}` with a reasonable HTTP status.
Request bodies are capped (16 KB default). Tokens, keys, and request
bodies are never logged.

## Pricing model

The unit sold and spent is the **credit** — it is deliberately not a
dollar amount, so a balance never implies a cash value.

- The `credits_099` pack costs **$0.99** and grants **15,000 credits** —
  15,000 lookups.
- Each successful `/format` lookup costs exactly **1 credit** (flat,
  regardless of the provider's own per-call cost).
- New accounts get **1,000 free starter credits**, exactly once.
- Daily caps: **250 credits per user** and **5,000 credits globally**
  (UTC day), enforced by the ledger before any provider spend.

Internally the ledger counts micros (1 credit = 10,000 micros): the pack
grants 150,000,000 micros, the starter grant is 10,000,000 micros, and a format
call reserves and settles 10,000 micros.

## Environment variables

See `.env.example` for the annotated list. The important ones:

| Variable | Purpose |
|---|---|
| `PORT` | Listen port (Railway sets this). |
| `DATA_DIR` | Directory for `aura.db`. Point at the mounted volume. |
| `GOOGLE_WEB_CLIENT_ID` | OAuth web client ID; the audience Google ID tokens must carry. |
| `SESSION_SECRET` | HMAC secret for session JWTs. Set a stable random value. |
| `STARTER_GRANT_MICROS` | One-time new-account grant (default `10000000` = 1,000 credits). |
| `FORMAT_CHARGE_MICROS` | Flat charge per successful format call, also the amount reserved before it (default `10000` = 1 credit). |
| `USER_DAILY_CAP_MICROS` / `GLOBAL_DAILY_CAP_MICROS` | Daily spend caps (defaults 250 credits / 5,000 credits). |
| `PROVIDER_BASE_URL` / `PROVIDER_API_KEY` / `PROVIDER_MODEL` | OpenAI-compatible provider used for format calls (e.g. OpenRouter). |
| `PLAY_PACKAGE_NAME` | Android package name, e.g. `com.aura.verselink`. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service-account JSON for the Play Developer API. |
| `PRODUCT_CREDITS_JSON` | `{"productId": creditMicros}` — the only source of grant amounts. |

## Run locally

```bash
npm install
cp .env.example .env   # fill in values
npm start              # node src/server.js
npm test               # node:test suites (no real network; all stubs local)
```

## Deploy on Railway

1. Create a project and a service from this repo (Nixpacks detects Node;
   `railway.json` supplies the start command and `/health` healthcheck).
2. Add a **volume** to the service and set `DATA_DIR` to its mount path
   (e.g. `/data`) so the SQLite database survives deploys.
3. Set the environment variables above in the service settings. Keep
   `PRODUCT_CREDITS_JSON` in sync with the products you create in Play
   Console.
4. Deploy. On the Free plan, Serverless (app sleeping) is forced — that's
   expected and fine: the service idles at ~zero cost, `/health` is the
   wake target, and the app handles the cold start (pre-warm ping when
   listening starts, retry on 502, keep-warm pings while listening).
5. Sanity-check: `GET https://<your-domain>/health` → `{"ok":true}`.

## TODOs for Android integration

- **Play Console:** create the credit products (consumable one-time
  products) with IDs matching `PRODUCT_CREDITS_JSON`; create a Google
  Cloud service account, download its JSON key into
  `GOOGLE_SERVICE_ACCOUNT_JSON`, and invite it in Play Console
  (Users and permissions) with access to the app and order/financial
  permissions so `purchases.products.get` succeeds.
- **Google sign-in:** register the Android OAuth client (package name +
  release SHA-1) alongside the web client; the app requests an ID token
  for the **web** client ID and posts it to `/auth/google`.
- **Billing client:** after Play reports a purchase, the app sends
  `{productId, purchaseToken}` to `/purchase/verify`, and only after a
  successful grant calls `consumeAsync` (and acknowledges the purchase)
  so the pack can be bought again. Set `obfuscatedAccountId` on the
  purchase to the backend's user identity flow you adopt — the backend
  rejects tokens whose obfuscated account ID doesn't match the caller.
- **Credits-mode provider:** when credits mode is selected, the app calls
  `/format` instead of a provider directly; handle 402 (prompt to buy
  credits), 429 (daily cap), and 502-with-retry (Railway wake-up).
- **Account deletion:** Google Play requires a deletion path — the app
  must expose a "delete account" action that calls
  `POST /account/delete` (plus the web deletion URL Play asks for).
- **Known v1 simplifications:** refund/chargeback clawbacks are not
  automated yet (watch Voided Purchases / RTDN and debit manually);
  the obfuscated-ID binding uses the backend's numeric user ID as the
  expected value — the Android side must set exactly that string.
