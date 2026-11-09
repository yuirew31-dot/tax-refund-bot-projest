# TaxRefund Bot — local beta validation and release

The Worker serves the static site, Telegram webhook, Groq-backed Q&A, and D1
event tracking. This guide separates local checks from production actions.

## Current release boundary

Local development does not send real Telegram messages. Real Groq calls are
disabled unless explicitly authorized and a newly rotated key is configured
for local development. Do not apply remote migrations, deploy, set a live
webhook, or send other external traffic without separate release approval.
The beta has no email-capture or checkout flow.

## Local validation

From this project directory:

```powershell
npm test
npx wrangler d1 migrations apply taxrefund-db --local
npm run dev -- --local
```

Wrangler stores local D1 state under `.wrangler/state`. Use the local Worker
URL (normally `http://localhost:8787`) for `/api/visit` and `/api/interest`.
The tests mock Telegram and Groq; never point them at production credentials.

The ordered migrations in `migrations/` are the source of truth for database
setup. `schema.sql` is a current-schema snapshot for inspection and tests, not
a replacement for applying migration history.

### Local website AI testing

For explicitly authorized local browser testing only, put the newly rotated
`GROQ_API_KEY` in a project-root `.env` file next to `wrangler.toml`. Wrangler
loads `.env` values into `wrangler dev`; this project ignores `.env` and
`.env.*` through its `.gitignore`. Do not put a key in source, `.dev.vars`,
command arguments, or URL paths. Do not run `wrangler secret put` for local
testing; it configures a remote Worker. Never print or commit the key.

The website sends one question at a time to `POST /api/chat`. The Worker
requires the same-origin request and a visitor cookie previously issued and
verified in local D1. The question and fixed system instructions are sent to
Groq; neither is written to app storage or logs. AI usage timestamps are
stored against the visitor ID and subject to the same per-client and global
quota windows as Telegram. Provider failures return generic messages; failed
provider requests still consume a reservation.

## Isolated Cloudflare staging

`wrangler.staging.toml` defines a separate Worker (`taxrefund-bot-staging`)
and D1 database (`taxrefund-bot-staging-db`). Do not use the production
`wrangler.toml` for staging database or deployment commands.
The staging Worker is publicly reachable on `workers.dev` and uses lower
limits of 3 requests per visitor per day/10 minutes and 5 requests globally
per day/3 per 10 minutes. These limits reduce, but do not eliminate, public
provider-cost exposure; disable or restrict staging when testing is complete.

Apply and verify staging migrations, then deploy only the staging Worker:

```powershell
npx wrangler d1 migrations list taxrefund-bot-staging-db --remote --config wrangler.staging.toml
npx wrangler d1 migrations apply taxrefund-bot-staging-db --remote --config wrangler.staging.toml
npx wrangler deploy --config wrangler.staging.toml
```

Worker secrets are separate per Worker. Add `GROQ_API_KEY` as a **Secret** to
the staging Worker in Cloudflare Dashboard → Workers & Pages →
`taxrefund-bot-staging` → Settings → Variables and Secrets. Never put its
value in this file, ordinary variables, or browser code. Do not add a Telegram
token or register a webhook for staging unless separately approved.

## Required configuration

Set secrets through Wrangler only after release approval; never put tokens in
source, `.dev.vars`, command arguments, or URL paths:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GROQ_API_KEY
```

`TELEGRAM_WEBHOOK_SECRET` must use Telegram's supported secret-token
characters (letters, digits, `_`, `-`). The Worker accepts only
`POST /telegram/webhook` and validates
`X-Telegram-Bot-Api-Secret-Token` before reading the request body.

The Groq beta defaults are bounded: 2,000 input characters, 600 output tokens,
2,600 output characters, a 15-second timeout, 10 requests per chat per UTC day,
5 per chat per 10 minutes, 50 globally per UTC day, and 10 globally per
10 minutes. Wrangler variables allow only values within the ceilings enforced
by the Worker. Failed provider requests still consume a reservation.

## Production release steps — approval required

Do not run these as part of local validation. Once the release owner approves:

1. Confirm the correct Cloudflare account, D1 database, Worker, and authorized
   Telegram bot. Rotate any previously exposed credentials.
2. With authorized read-only access, inspect the remote D1 migration history
   and actual table columns. This chain has been verified on a fresh local D1
   database only. Do not apply it blindly to an existing database: migration
   `0002_add_event_type.sql` adds a column that may already exist in a database
   initialized from an earlier schema snapshot. If the recorded history and
   actual schema disagree, stop and agree an adoption/reconciliation plan
   before applying any migration.
3. Apply the migration chain to the approved remote D1 database:

   ```powershell
   npx wrangler d1 migrations apply taxrefund-db --remote
   ```

4. Configure the secrets above and deploy:

   ```powershell
   npm run deploy
   ```

5. Register the exact webhook endpoint using Telegram's `secret_token` field.
   Keep both values in protected environment variables; do not put the webhook
   secret in the URL:

   ```powershell
   $payload = @{
     url = "$env:WORKER_URL/telegram/webhook"
     secret_token = $env:TELEGRAM_WEBHOOK_SECRET
     allowed_updates = @("message", "callback_query")
   } | ConvertTo-Json -Compress
   Invoke-RestMethod `
     -Uri "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/setWebhook" `
     -Method Post -ContentType "application/json" -Body $payload
   ```

6. Verify the approved deployment using a controlled test chat. Check `/start`,
   all eight quiz steps, stale/duplicate callbacks, `/ask`, the guide, and
   `/delete`. Confirm quotas and D1 writes without exporting user content.
7. Confirm the site does not promise a paid report, email signup, tax outcome,
   or feature that is not implemented.

## Data and beta behavior

- `/api/visit` creates an anonymous visitor identifier; supported interest
  events may be linked to it when the valid first-party cookie is present.
- Email collection is disabled. Interest-event rows store `email` as `NULL`.
- Telegram quiz state and AI usage counters are stored in D1. `/delete` removes
  those app records for the private chat; it cannot erase Telegram history or
  provider-side records.
- Questions are sent to Groq when AI Q&A is configured. Do not send sensitive
  identity or tax-return information.
- Quiz results and AI responses are educational information, not tax advice.

## Local development

```powershell
npm run dev
```
