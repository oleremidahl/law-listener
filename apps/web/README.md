# Law Listener Frontend (`apps/web`)

Public, read-only frontend for browsing law proposals and linked legal documents.

## Stack

- Next.js App Router (TypeScript)
- shadcn/ui + Tailwind CSS
- Supabase read-only API access (publishable key)
- Vitest + React Testing Library + Playwright

## Required environment variables

Create `apps/web/.env.local` with:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<sb_publishable_key>
```

Backward compatibility: `NEXT_PUBLIC_SUPABASE_ANON_KEY` is still accepted if `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is not set.

## Scripts

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:component
pnpm test:e2e:smoke
```

## Routes

- `/`: proposal list with search, status/date filters, pagination, and manual refresh.
- `/proposal/[id]`: proposal detail with linked documents.
- `/api/proposals`: read-only list API used by the UI.
- `/api/proposals/[id]`: read-only detail API used by the UI.
