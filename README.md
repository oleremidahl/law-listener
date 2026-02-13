# Law Listener

Law Listener tracks Norwegian law decisions, enriches them with linked legal documents, and presents the result in a public read-only web interface.

## Project Summary

The project is built as a pipeline:

1. A scheduled Cloudflare worker reads the Stortinget RSS feed.
2. New proposals are ingested into Supabase.
3. A matcher worker + edge function extract legal references and link proposals to legal documents.
4. An edge function generates cached AI summaries (OpenAI `gpt-4.1-mini`) on-demand per proposal status.
5. A Next.js frontend exposes searchable proposal and detail views.

## Current Repository Structure

- `apps/web`: public frontend (Next.js + shadcn/ui).
- `workers/stortinget-rss-worker`: feed ingestion worker (Rust/Cloudflare).
- `workers/stortinget-law-matcher`: proposal matcher worker (Rust/Cloudflare).
- `supabase/functions`: edge functions for ingesting and matching/linking.
- `.github/workflows`: CI and deployment workflows.

## Runtime Characteristics

- Read-only frontend data access.
- Structured logging across workers and edge functions.
- Request ID propagation (`x-request-id` in, `X-Request-ID` out).
- Edge-function error reporting to Sentry (fail-open).

## Frontend Hosting

The frontend hosting target is intentionally left open for now.
Deployment hosting/provider will be finalized separately.

## CI/CD at a Glance

- `frontend-ci.yml`: frontend lint, typecheck, unit/component/e2e smoke.
- `observability-ci.yml`: workers Rust checks/tests + wasm target check, edge Deno checks/tests.
- `deploy-workers.yml`: deploy Cloudflare workers on `master` changes under `workers/**`.
- `deploy-edge-functions.yml`: deploy Supabase edge functions on `master` changes under `supabase/functions/**`.

## Documentation

- Frontend app docs: `apps/web/README.md`
- Self-hosting guide (your own Supabase/Cloudflare): `SELF_HOSTING.md`

## Contributing

- Branch from `master`.
- Keep changes scoped by domain when possible.
- Ensure relevant CI checks pass before merge.
- Never log secrets or raw sensitive payload/body content.
