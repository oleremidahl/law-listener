# Self-Hosting Guide

This guide explains how to run your own copy of Law Listener with your own Supabase and Cloudflare accounts.

## What You Need

- Node.js `>= 20.9.0`
- `pnpm` `9.15.4`
- Rust stable toolchain (`cargo`)
- Deno 2.x
- Supabase CLI
- Wrangler CLI

## 1. Fork/Clone and Install

```bash
git clone <your-fork-url>
cd law-listener
pnpm install
```

## 2. Create a Supabase Project

1. Create a new Supabase project.
2. Apply your schema/migrations for required tables (`law_proposals`, `legal_documents`, `proposal_targets`, etc.).
3. Collect:
- Project URL
- Publishable key (for frontend)
- Service role key (for edge functions)
- Project ref (for deploy workflow)

## 3. Configure Edge Functions

Create `supabase/functions/.env`:

```bash
STORTINGET_WORKER_SECRET=<your-ingest-secret>
LAW_MATCHER_WORKER_SECRET=<your-matcher-secret>
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
SENTRY_DSN=<optional-sentry-dsn>
```

Notes:
- `SENTRY_DSN` is optional. If missing, edge functions continue without Sentry.
- Use strong random values for both worker secrets.

## 4. Configure Cloudflare Workers

Each worker has its own `wrangler.toml`:

- `workers/stortinget-rss-worker/wrangler.toml`
- `workers/stortinget-law-matcher/wrangler.toml`

You must set/update:

- `EDGE_FUNCTION_URL` for RSS worker to your Supabase ingest endpoint.
- `LAW_MATCHER_EDGE_FUNCTION_URL` for matcher worker to your Supabase matcher endpoint.
- KV namespace binding for RSS worker (`STORTINGET_STATE`) in your own Cloudflare account.

Set worker secrets via Wrangler (do not commit):

```bash
cd workers/stortinget-rss-worker
wrangler secret put STORTINGET_WORKER_SECRET

cd ../stortinget-law-matcher
wrangler secret put WEBHOOK_SHARED_SECRET
wrangler secret put LAW_MATCHER_WORKER_SECRET
```

## 5. Configure Frontend

Create `apps/web/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<your-publishable-key>
```

Then run locally:

```bash
pnpm dev
```

## 6. Run Validation Locally

Frontend checks:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:component
pnpm test:e2e:smoke
```

Worker checks/tests:

```bash
cargo check --manifest-path workers/stortinget-rss-worker/Cargo.toml
cargo test --manifest-path workers/stortinget-rss-worker/Cargo.toml
cargo check --manifest-path workers/stortinget-law-matcher/Cargo.toml
cargo test --manifest-path workers/stortinget-law-matcher/Cargo.toml
```

Edge checks/tests:

```bash
deno fmt --check supabase/functions
deno lint supabase/functions
deno test --allow-env supabase/functions/shared/logger_test.ts
```

## 7. Deploy

### Supabase Edge Functions

```bash
supabase functions deploy --project-ref <your-project-ref>
```

### Cloudflare Workers

```bash
cd workers/stortinget-rss-worker
cargo install -q worker-build@^0.7 && worker-build --release
wrangler deploy

cd ../stortinget-law-matcher
cargo install -q worker-build@^0.7 && worker-build --release
wrangler deploy
```

### Frontend

Deploy `apps/web` to your preferred host (Vercel, Cloudflare Pages, etc.) with the same `NEXT_PUBLIC_SUPABASE_*` env values.

## 8. GitHub Actions (Optional)

If you want automated deploys from your fork, set GitHub repo secrets/vars used by workflows:

- `WRANGLER_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID` (repo variable)
- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_ID` (repo variable)

## 9. Security Notes

- Never commit secrets.
- Keep service-role keys server-only.
- Keep logging redaction intact; avoid adding logs with raw payload/body/html content.
