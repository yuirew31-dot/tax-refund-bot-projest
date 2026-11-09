# TaxRefundBot — Sprint 1D D1 Migration Integrity

**Observation date:** 2026-11-07  
**Scope:** Fresh local D1 migration chain, current schema snapshot, and local Worker/D1 behavior. No remote D1 operation was performed.

## Outcome

The project now has a complete ordered migration chain for a fresh database.
All five migrations applied successfully to an isolated local Wrangler D1
database, and the local Worker persisted anonymous visit and interest events.
This does not establish that the chain is safe to apply to an existing remote
database; remote history and live columns remain uninspected.

## Baseline failure and repair

Before the change, migrations `0002_add_event_type.sql` and
`0003_add_traffic_type.sql` both expected an `interest_events` table, but no
initial migration created it. Applying the chain to an empty D1 database
therefore failed with `no such table: interest_events`. The previous
`schema.sql` snapshot could initialize tables, but it did not include the
`traffic_type` column.

The repair preserves the two historical migrations and adds:

- `0001_initial_schema.sql` — initial visitor, event, and bot-state tables.
- `0004_add_quiz_session.sql` — session-bound quiz state.
- `0005_add_usage_and_event_attribution.sql` — event attribution, AI usage
  reservations, indexes, and provider cooldown storage.

`schema.sql` now represents the current schema. Fresh database setup uses the
migration chain, not the snapshot.

## Verification

On 2026-11-07 with Node.js 24.16.0 and Wrangler 4.127.1:

- `npx wrangler d1 migrations apply taxrefund-db --local --persist-to <isolated-temp-path>` — exit 0; all five migrations applied.
- Local D1 inspection confirmed `bot_state.session_id`, `interest_events.traffic_type` and `interest_events.visitor_id`, plus `ai_usage` and `provider_cooldowns`.
- A local `wrangler dev --local` Worker returned 200 for `/api/visit` and `/api/interest`, set a first-party visitor cookie, and stored a linked `real_visit` and `artifact_intent` with `email = NULL`.
- The Worker rejected `GET /telegram/webhook` with 405.
- The conditional quota insert against local D1 allowed one reservation at a one-request limit and left the count at one on a second attempt.
- SQLite-backed Worker integration tests cover transactional batches, callback races, UTC quota windows, and zero/one affected-row behavior.
- `npm test -- --test-reporter=spec` — 48 passed, 0 failed.

All Worker test network calls were mocked. Local Worker smoke requests used
only `localhost`; no real Telegram or Groq request was made.

## Existing-database release blocker

The chain was validated only on a fresh local D1 database. In particular,
`0002_add_event_type.sql` is not idempotent. A database initialized from an
older schema snapshot may already have `event_type` while its
`d1_migrations` history does not record `0002`. Applying the fresh chain to
such a database could fail on a duplicate column.

Before any remote migration:

1. Obtain explicit release authorization and use an authorized operational
   role.
2. Read and compare the remote migration history and actual table columns.
3. If history and schema disagree, stop and agree a reviewed adoption or
   reconciliation plan. Do not edit historical migrations or mark them
   applied by assumption.
4. Take the approved backup and apply only the reviewed plan.

No remote D1 reads or writes, deployment, webhook registration, or live
provider calls were performed in this work.
