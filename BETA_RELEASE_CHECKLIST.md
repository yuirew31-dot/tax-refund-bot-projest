# TaxRefundBot Controlled Beta — Release Checklist

**Observation date:** 2026-11-07  
**Status:** Local implementation verified; production release is not approved
or performed.

## Local implementation and validation

- [x] Add an initial migration and restore a complete fresh-D1 migration chain.
- [x] Apply all six migrations to an isolated local Wrangler D1 database.
- [x] Verify local Worker `/api/visit` and `/api/interest` writes, including
      first-party visitor attribution and `email = NULL`.
- [x] Verify exact Telegram webhook route/method/body validation.
- [x] Verify private-chat quiz, session-bound callback transitions, duplicate
      and concurrent callback handling, and completion replay behavior.
- [x] Verify `/delete` removes the app's quiz and AI usage records.
- [x] Verify Groq limits, quota windows, provider cooldown, timeout, and
      sanitized failure behavior with mocked network calls.
- [x] Add same-origin website Q&A with visitor-scoped quota accounting and
      bounded, non-persisted questions and answers.
- [x] Verify website AI success, input validation, quota rejection, and generic
      provider errors with mocked network calls.
- [x] Run `npm test -- --test-reporter=spec` — 51 passed, 0 failed.
- [x] Run `node --check src/worker.js`.
- [x] Run `npx wrangler deploy --dry-run` with no deployment.
- [x] Update [DEPLOY.md](./DEPLOY.md), Privacy, Terms, and beta claims.
- [x] No real Telegram or Groq request from the TaxRefundBot Worker/tests; no
      remote D1 operation or deployment.

## Release blockers — all require explicit approval

- [ ] Confirm the release owner and the authorized account, Worker, D1
      database, and Telegram bot.
- [ ] Perform an authorized read-only review of remote D1 migration history and
      actual columns. The fresh chain is not verified for an existing database;
      `0002_add_event_type.sql` may conflict if `event_type` already exists but
      is unrecorded in migration history. Stop for a reviewed reconciliation
      plan if history and schema differ.
- [ ] Confirm approved backup/restore and rollback procedures. Migrations are
      additive; do not reset or overwrite remote D1.
- [ ] Confirm all secrets are newly issued/rotated, protected, and not present
      in source, shell history, or public configuration.
- [ ] Run the real website-to-Groq flow with a newly rotated key in the
      approved local-only configuration. The key was not present during the
      latest local validation, so no real Groq request was made.
- [ ] Confirm provider/account spend and rate limits align with the configured
      Groq caps.
- [ ] Review the current tax-year figures and legal/privacy wording against
      current primary sources before public use.
- [ ] Obtain explicit authorization for remote migrations and deployment.

## Only after blockers are cleared

- [ ] Apply the reviewed remote D1 migration/adoption plan.
- [ ] Configure Telegram and Groq secrets, then deploy the Worker.
- [ ] Register only `POST /telegram/webhook` using Telegram's
      `secret_token` field; never place the secret in the URL.
- [ ] Run a controlled test in the approved private Telegram chat: `/start`,
      quiz completion, `/ask`, guide, `/delete`, and rate-limit behavior.
- [ ] Verify D1 writes and data deletion without exporting user content.
- [ ] Confirm the landing page makes no email, checkout, paid-report, or
      guaranteed-tax-outcome claim.
- [ ] Record release owner, date, exact deployed revision, migration history,
      rollback decision, and post-release monitoring owner.

## Rollback and incident response

- Revert the Worker version using the approved Cloudflare procedure if the
  application is unhealthy. Keep additive D1 migrations in place unless a
  reviewed database rollback plan explicitly says otherwise.
- Disable or rotate compromised Telegram/Groq credentials immediately.
- Pause the bot/webhook if provider limits or data handling behave
  unexpectedly; do not inspect or export user question content to troubleshoot.
- Report incidents through the authorized owner and operational channel.
