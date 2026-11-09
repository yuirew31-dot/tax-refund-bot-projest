# TaxRefundBot — Telegram and Groq Beta Hardening

**Observation date:** 2026-11-07  
**Scope:** Worker, schema, public beta claims, privacy/terms copy, regression coverage, and local-only verification.

## Implemented

- Telegram webhook accepts only `POST /telegram/webhook`, authenticates the
  `X-Telegram-Bot-Api-Secret-Token` header before reading the bounded body, and
  validates update structure. Group chats do not receive quiz or AI behavior.
- Quiz callbacks carry a per-run session ID and question identity. Conditional
  D1 transitions prevent stale, duplicate, or racing callbacks from advancing
  state twice. A completed quiz cannot resend its report from a replayed final
  callback.
- `/delete` removes the private chat's saved quiz state and AI usage
  reservations. The confirmation accurately excludes Telegram history and
  provider-side records.
- Groq requests use bounded input/output and timeout settings; quota
  reservations enforce per-chat and global UTC-day/10-minute limits. Provider
  `Retry-After` responses create a persisted cooldown. Missing, invalid, or
  unavailable quota storage fails closed.
- Telegram and Groq fetches have timeouts and explicit error mapping. Logs
  record only sanitized source/category data; user questions and provider
  response bodies are not logged or persisted by the app.
- Interest events no longer collect email. Visitor attribution is accepted only
  for a visitor ID that exists in D1. The landing, Privacy, Terms, and
  [DEPLOY.md](./DEPLOY.md) now reflect implemented beta behavior and remove
  simulated checkout/email and unsupported social-proof claims.
- EITC quiz output is a review prompt, not an eligibility result derived from
  a broad income band. The bot retains its educational disclaimer and tax-year
  guardrails.

## Verification evidence

The regression suite contains 48 passing tests, including local SQLite-backed
tests for:

- exact webhook route/method/body and update validation
- callback session binding, concurrent transition races, stale and repeated
  callbacks, completion replay, and `/delete`
- actual Worker SQL for visitor attribution and email remaining `NULL`
- concurrent chat/global quota reservation and UTC window reset behavior
- Groq output bounds, request quota, provider cooldown, and timeout
- Telegram network, HTTP 429, and malformed-JSON errors
- AI response HTML escaping, educational disclaimer, and no question-text
  persistence

The Wrangler local D1 migration chain and local Worker API routes were also
exercised. A deployment dry run and final syntax check are recorded in the
release checklist.

## Operational boundary

No production deployment, remote D1 operation, real Telegram message, or
webhook registration was made. All TaxRefundBot Worker/test outbound requests
were replaced with controlled mocks. Provider use by unrelated tooling is
outside this project report. Release remains blocked pending an authorized
review of remote D1 migration history/schema, secret and bot verification, and
owner approval. See [BETA_RELEASE_CHECKLIST.md](./BETA_RELEASE_CHECKLIST.md).
