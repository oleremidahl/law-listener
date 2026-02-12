# Law Listener

Law Listener ingests Norwegian law decisions from Stortinget, enriches them by linking related legal documents, and serves a public read-only frontend for browsing proposals and links.

## Architecture

- `workers/stortinget-rss-worker`: Cloudflare Rust worker that polls the Stortinget RSS feed and forwards new entries to Supabase Edge Function ingestion.
- `workers/stortinget-law-matcher`: Cloudflare Rust worker that receives webhook events, extracts law IDs from proposal pages, and calls the matcher Edge Function.
- `supabase/functions/ingest-stortinget`: Edge Function that upserts proposals into `law_proposals`.
- `supabase/functions/match-and-link-laws`: Edge Function that links proposals to `legal_documents` via `proposal_targets`.
- `supabase/functions/upsert-test-proposal`: Edge test/utility function for controlled DB upsert checks.
- `apps/web`: Next.js frontend for public browsing (`/`, `/proposal/[id]`).

## Repository Layout

- `apps/web`: frontend app and frontend tests.
- `workers`: Cloudflare Rust workers.
- `supabase/functions`: Supabase Edge Functions.
- `.github/workflows`: CI and deployment pipelines.

## Prerequisites

- Node.js `>= 20.9.0` (Node 22 recommended).
- `pnpm` `9.15.4`.
- Rust stable toolchain (`cargo`).
- Deno 2.x.
- Supabase CLI.
- Wrangler CLI.

## Environment Setup

Create environment files locally (do not commit secrets):

- `apps/web/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<sb_publishable_key>
```

- `supabase/functions/.env` (example keys):

```bash
STORTINGET_WORKER_SECRET=<secret>
LAW_MATCHER_WORKER_SECRET=<secret>
SENTRY_DSN=<dsn>
```

## Quick Start

Install dependencies:

```bash
pnpm install
```

Run frontend:

```bash
pnpm dev
```

Frontend docs are in `apps/web/README.md`.

## Common Commands

Frontend:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:component
pnpm test:e2e:smoke
```

Workers:

```bash
cargo check --manifest-path workers/stortinget-rss-worker/Cargo.toml
cargo test --manifest-path workers/stortinget-rss-worker/Cargo.toml
cargo check --manifest-path workers/stortinget-law-matcher/Cargo.toml
cargo test --manifest-path workers/stortinget-law-matcher/Cargo.toml
```

Edge functions:

```bash
deno fmt --check supabase/functions
deno lint supabase/functions
deno test --allow-env supabase/functions/shared/logger_test.ts
```

## Testing Matrix

- Frontend: Vitest unit/component + Playwright smoke tests.
- Workers: Rust unit tests in `src/lib.rs` for parsing/extraction/request-id helpers.
- Edge functions: Deno tests for shared logger helpers and response/request-id utilities.

## Observability

- Structured logging is enabled in workers and edge functions.
- Request IDs are propagated via `x-request-id` and returned as `X-Request-ID`.
- Edge function errors/fatals report to Sentry (`SENTRY_DSN`) with fail-open behavior.
- Redaction policy blocks sensitive keys while keeping safe metric fields (for example `*_type`, `*_length`, `*_count`).

## CI/CD

- `frontend-ci.yml`: lint, typecheck, unit/component/e2e for `apps/web` changes.
- `observability-ci.yml`: worker Rust checks/tests + wasm32 check, and edge Deno fmt/lint/test.
- `deploy-workers.yml`: deploy Cloudflare workers on push to `master` when `workers/**` changes.
- `deploy-edge-functions.yml`: deploy Supabase Edge Functions on push to `master` when `supabase/functions/**` changes.

## Troubleshooting

Node version mismatch:

```bash
node -v
```

If below required version, upgrade Node before running Next.js.

Deno command not found:

- Ensure Deno is installed and on `PATH`.
- Verify with `deno --version`.

Deno dependency/type resolution issues:

- This repo uses a root `deno.json` with import maps and `nodeModulesDir: "auto"`.
- Re-run the Deno commands from repo root.

## Contributing

- Branch from `master`.
- Keep changes scoped by domain (frontend vs workers/edge).
- Ensure relevant CI checks pass before PR merge.
- Do not log secrets or raw sensitive payload content.
