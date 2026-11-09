# TaxRefundBot — Sprint 1C.1 Event Integrity & Abuse Resistance

> **Historical report.** This records the implementation state at Sprint 1C.1
> and is superseded for current beta behavior by
> [Sprint 1D D1 Migration Integrity](./SPRINT_1D_D1_MIGRATION_INTEGRITY_REPORT.md)
> and [Telegram/Groq Beta Hardening](./TELEGRAM_GROQ_BETA_HARDENING_REPORT.md).
> In particular, the email and simulated-payment descriptions below are not
> the current product contract.

## 1. Baseline findings

The current repo already included a secure Telegram webhook implementation and a public analytics route removal. The remaining concrete risks were in the request-parser and visitor-tracking path:

- `readJsonBody()` buffered the entire request body before enforcing the 32 KB limit.
- `classifyTraffic()` trusted client-supplied metadata for QA and owner attribution.
- `parseVisitorCookie()` accepted syntactically valid cookie IDs without verifying they existed in D1.
- `/api/visit` performed two independent D1 writes, which allowed partial persistence on failure.
- No distributed rate-limiting binding was configured in the local Worker definition.
- Webhook regression coverage needed explicit tests for empty secret, empty header, incorrect secret, and malformed unauthorized payloads.

## 2. Local implementation changes

### Files changed
- `src/worker.js`
- `test/worker.test.js`
- `public/index.html`

### Implemented changes
1. `readJsonBody()` now:
   - validates the media type as `application/json` with optional `; charset=...` parameters
   - reads the body incrementally from the stream
   - stops as soon as the 32 KB ceiling is crossed
   - cancels the remaining stream when over-limit
   - rejects empty, malformed, and invalid UTF-8 bodies before parsing
   - preserves existing 400 and 415 behavior for invalid input

2. `classifyTraffic()` now treats only a verifiable localhost hostname as QA. Production visitors are conservatively classified as `external_unknown`, regardless of `ref`, `User-Agent`, or URL fragments supplied by the browser.

3. `/api/visit` now:
   - validates cookie syntax
   - queries D1 for the cookie value before accepting it as a returning visitor
   - issues a new UUID only when the cookie is missing, malformed, or not found in D1
   - uses `env.DB.batch([...])` for the visitor insert and the matching `real_visit` interest event insert so both succeed together or neither is committed

4. The frontend visitor ping remains POST-only and continues to send a first-party cookie without relying on a GET-side mutation.

## 3. Request-body streaming behavior

The request parser now consumes the incoming stream incrementally and enforces the limit before JSON parsing. This prevents oversized bodies from being fully buffered and keeps the route fail-closed at the request boundary.

Key behavior:
- `Content-Type: application/json;charset=utf-8` is accepted.
- `application/jsonp` and unrelated media types are rejected.
- a body exactly at the 32 KB ceiling is allowed when valid JSON
- a body one byte over the limit returns HTTP 413 without D1 writes
- malformed JSON and invalid UTF-8 return HTTP 400
- empty or missing bodies return HTTP 400

## 4. Traffic classification policy

Client-supplied metadata is not treated as trusted provenance.

Policy:
- only `localhost`/loopback/`*.localhost` is considered verified QA
- `ref` strings such as `qa`, `preview`, or `smoke` do not reclassify production traffic as QA
- personal email strings, URL fragments, and browser metadata do not establish ownership
- `User-Agent` is not used as proof of automation or identity

The default production classification remains `external_unknown`.

## 5. Visitor cookie verification behavior

The stored first-party visitor cookie is treated as a deduplication aid, not a trusted identity or abuse-proof record.

Behavior:
- valid-looking IDs are checked against `visitors` in D1
- only an existing row qualifies for `newVisitor: false`
- missing, malformed, or non-existent IDs create a fresh UUID
- no public response exposes the internal DB identifier
- cookie attributes remain `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` on HTTPS

## 6. D1 atomicity evidence

The visitor write path now uses a single D1 batch for both statements:
- `INSERT INTO visitors ...`
- `INSERT INTO interest_events ...` with `event_type = 'real_visit'`

This matches the requirement that both inserts succeed together, or neither is committed. The local tests cover the success path and the failure path where the batch is rejected.

## 7. Rate-limiting configuration status

`wrangler.toml` does not configure a supported distributed rate-limiting or abuse-protection binding for the Worker.

Status: `NOT CONFIGURED` / `BLOCKED` at the infrastructure level.

This is explicitly documented as an external requirement, not a local implementation claim. The project does not create new Cloudflare resources, account bindings, or billing-backed rate limit settings in this session.

## 8. Webhook regression coverage

The webhook security tests explicitly cover:
1. missing server secret
2. empty server secret
3. missing request header
4. empty request header
5. incorrect request secret
6. correct request secret
7. malformed JSON rejected before parsing
8. unauthorized requests with no handler invocation or D1 writes

These are exercised through the real `worker.fetch(...)` route and use synthetic secrets only.

## 9. Email / privacy findings

The email and privacy contract is consistent with the actual implementation:
- email collection is optional and used only for a launch notice or follow-up CTA flow
- the policy says the email may be left blank
- no personal tax or identity data is collected in the quiz or interest event pipeline
- event names such as `payment_intent` and `payment_started` are client-reported event markers, not verified revenue outcomes

The client-side event semantics are therefore documented as informational telemetry, not proof of payment or completed transactions.

## 10. Test evidence and commands

### Local behavioral verification
Commands run:
- `Set-Location 'd:\lev\Ignition\projects\008-taxrefund-bot'; npm test -- --test-reporter=spec`
- exit code: 0
- result: 38 passed, 0 failed

- `Set-Location 'd:\lev\Ignition\projects\008-taxrefund-bot'; node --check src/worker.js`
- exit code: 0

- `git -C 'D:\Lev\Ignition' --no-pager diff --check -- projects/008-taxrefund-bot/src/worker.js projects/008-taxrefund-bot/test/worker.test.js projects/008-taxrefund-bot/public/index.html`
- exit code: 0

### Wrangler validation
Command run:
- `Set-Location 'd:\lev\Ignition\projects\008-taxrefund-bot'; npx wrangler deploy --dry-run`
- exit code: 0
- result: Worker config and bindings were parsed successfully; no deployment occurred.

## 11. Local implementation vs. production verification

### Local implementation
- implemented and verified locally: yes

### Local behavioral verification
- automated regression tests passed: yes

### Wrangler dry-run
- config validation executed locally: yes

### Production configuration verification
- not independently verified externally: yes, not claimed

### Production deployment
- not performed: yes

## 12. Remaining risks and blockers

- distributed rate limiting is not configured in the project and remains an external infrastructure requirement
- any production configuration validation must be completed by an authorized Cloudflare operator outside this local-only session
- the project still does not claim full production readiness or anti-abuse guarantees beyond the local code and tests

## 13. Final status

This sprint’s locally implementable integrity issues were fixed and verified in code. Rate limiting remains an external blocker because there is no distributed enforcement mechanism configured in the local Worker definition.

Status classification:
- Stream-bounded body parsing: PASS
- Strict JSON content type: PASS
- Traffic provenance: PASS
- Visitor cookie backed by D1: PASS
- Atomic visitor/event writes: PASS
- Distributed rate limiting: NOT CONFIGURED
- Webhook regression coverage: PASS
- Email/privacy contract: CONSISTENT
- Client-reported event semantics: DOCUMENTED
- Existing tests: PASS
- Changed-file diff hygiene: PASS
- Secret hygiene: PASS

Overall: PASS for the locally implemented security and data-integrity work, with a clearly separated infrastructure blocker for distributed rate limiting.

## Sprint 1C.2 — Verification Closure

**Observation date:** 2026-11-05

**Scope:** local repository and isolated local Wrangler D1 only. No `--remote` command, production database, deployment, or live external API was used.

### Instrumented stream test

Added real Worker-path tests in `test/worker.test.js`. The request body is a `ReadableStream` with a zero high-water mark and 4,096-byte chunks; its source records chunk pulls, bytes delivered, cancellation, and completion. The tests call `worker.fetch()` for `POST /api/interest`, not only the parser helper.

- Exact 32,768-byte valid JSON: accepted with HTTP 200; exactly 32,768 bytes delivered and the stream completed.
- Valid JSON one byte over (32,769 bytes): rejected with HTTP 413 and stream cancellation.
- Oversized valid 128-KiB JSON: rejected with HTTP 413 after 9 of 32 chunks, or 36,864 of 131,072 bytes, were delivered. The remaining 23 chunks were not consumed; cancellation was requested and the stream did not complete.
- The oversized test wraps `JSON.parse` with a counter and observes zero calls; its D1 mock observes zero operations.
- Additional input checks: invalid UTF-8 -> 400; empty body -> 400; `application/json; charset=utf-8` -> accepted; `application/jsonp` -> 415.

These are mocked-D1 behavioral tests; they establish stream consumption and request ordering, not database transaction behavior.

### Actual local D1 setup and isolation

Used Wrangler 4.127.1 with a temporary config pointing to the actual `src/worker.js`, a synthetic binding named `taxrefund-sprint1c2-local`, synthetic database ID `00000000-0000-0000-0000-000000000001`, explicit `--local`, loopback-only `wrangler dev`, and a fresh mission-specific `--persist-to` directory under the OS temp directory. The generated D1 database was queried empty before the request tests. Setup used `schema.sql` plus `migrations/0003_add_traffic_type.sql`; the base schema already contains `event_type`, so migration 0002 was not reapplied.

All D1 commands named the synthetic database and included `--local --persist-to`; Wrangler output confirmed “Resource location: local” and the synthetic database ID. The default project D1 binding/database ID was not used for these tests.

Local D1 command outcomes:

- `wrangler d1 execute taxrefund-sprint1c2-local --config <temp>\wrangler.jsonc --local --persist-to <temp>\persistence-verified --file schema.sql` — exit 0.
- The same command with `--file migrations\0003_add_traffic_type.sql` — exit 0.
- Empty-database SQL query before the route test — exit 0; 0 visitors, 0 events.
- Success route request via loopback `curl` — curl exit 0; HTTP 200.
- Success-count SQL query after stopping the Worker — exit 0; 1 visitor, 1 real_visit event.
- Local trigger creation — exit 0; trigger existence and baseline-count query — exit 0.
- Forced-failure route request via loopback `curl` — curl exit 0; HTTP 500.
- Post-failure rollback SQL query after stopping the Worker — exit 0; 1 visitor, 1 real_visit event, trigger present.

### Successful `/api/visit` batch

An HTTP POST to the running local Worker returned HTTP 200 with `{"ok":true,"newVisitor":true}`. The cookie value was redacted from captured output; the returned cookie included `Path=/`, `Max-Age=31536000`, `SameSite=Lax`, and `HttpOnly`. The local test server used HTTP, so the conditional `Secure` attribute was not expected on this response; the existing automated HTTPS cookie test still verifies `Secure`.

After stopping the Worker to avoid concurrent access to its SQLite-backed state, a Wrangler local SQL query returned:

- `visitor_count = 1`
- `real_visit_count = 1`

### Forced second-statement failure and rollback

In the isolated local database only, created a SQLite `BEFORE INSERT` trigger that raises `ABORT` for `event_type = 'real_visit'`. SQL confirmed the trigger existed and baseline counts were one visitor and one event. The same route request then returned HTTP 500 with the generic `storage_unavailable` body and no `Set-Cookie`.

After stopping the Worker, a separate local SQL query confirmed:

- `visitor_count = 1` (unchanged from baseline; no partial visitor from the failed request)
- `real_visit_count = 1` (the successful request's event remains)
- `failure_trigger_count = 1` (the controlled second-statement failure was active)

This is actual Wrangler local D1 execution through the Worker route, not a mocked `batch()` result.

### Regression and command results

- `node --test test/worker.test.js` — exit 0; 41 passed, 0 failed.
- `npm test -- --test-reporter=spec` — exit 0; 41 passed, 0 failed.
- `node --check src/worker.js` — exit 0.
- `npx wrangler deploy --dry-run` — exit 0; configuration parsed and no deployment occurred.
- `git diff --check` — exit 0. The containing Git repository reports this project directory as untracked, so that command does not cover its untracked contents; a direct trailing-whitespace check of changed files is also recorded below.
- Direct whitespace check on the changed project and vault files — PASS (no trailing whitespace).

Webhook fail-closed tests, `/api/stats` denial, `/api/interest` validation, visitor cookie regressions, and the existing HTTPS `Secure` cookie test all remain in the passing suite. No frontend files or behavior were changed; no browser audit was repeated.

### Acceptance status

| Requirement | Status |
|---|---|
| Instrumented stream test | PASS |
| Oversized stream not fully consumed | PASS |
| Stream cancellation | PASS |
| Exact 32 KB test | PASS |
| Local D1 batch success | PASS |
| Real local D1 rollback | PASS |
| No partial visitor after rollback | PASS |
| Existing 38+ regression tests | PASS (41) |
| Wrangler dry-run | PASS |
| Production rate limiting | NOT CONFIGURED |

**Overall:** PASS for the two requested local verification properties and regression checks.

### Limitations and separated claims

- The local D1 runtime proves behavior for the local Wrangler/D1 implementation and this schema/trigger setup; it does not verify production data or Cloudflare production configuration.
- Production rate limiting remains `NOT CONFIGURED` / externally unverified.
- Local code/tests and dry-run: verified. Production configuration: not independently verified. Production deployment: not performed.
- Mission-created temporary persistence/config/request files were cleaned up after validation.
