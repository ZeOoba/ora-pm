# ORA Property Manager

Internal property management platform for Oxford Realty Advisors.

## Tech Stack

- Vite + React 19 + TypeScript + Tailwind v4
- Hono on Cloudflare Pages Functions
- Supabase (Postgres + Auth + Storage)
- Stripe ACH (Phase 2)

## Development

```bash
npm install
cp .env.example .env        # fill in Supabase URL/keys + CRON_SECRET
npm run dev                 # Vite dev server on :5173
npm test                    # Vitest unit tests
npm run typecheck           # TypeScript type check
npm run build               # Production build
```

## Deployment (Cloudflare Pages — Manual Steps)

1. Create a Supabase project at supabase.com
   - Copy URL + anon key → VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
   - Copy service role key → SUPABASE_SERVICE_ROLE_KEY
   - Run migrations: `supabase db push`

2. Connect GitHub repo to Cloudflare Pages
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Environment variables: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
   - Encrypted secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

3. Configure Cloudflare Access (Zero Trust)
   - Protect the Pages deployment
   - Allow: ggoldberg@oxfordra.net, egoldberg@oxfordra.net

4. DNS (REQUIRES EXPLICIT CONFIRMATION — do not set without Gabriel's go-ahead)
   - pm.oxfordra.net CNAME → ora-pm.pages.dev
   - tenant.oxfordra.net CNAME → ora-pm.pages.dev (Phase 2)

## Monthly Billing Cron

Run `scripts/trigger-billing.ps1` on the 1st of each month via Windows Task Scheduler.
Set env var `ORA_PM_CRON_SECRET` to match the CRON_SECRET Cloudflare Pages secret.

## Phase 2 (Tenant Portal + Stripe)

Separate implementation plan. See design doc at:
`Claude_Workspace/01_Workspace/docs/superpowers/specs/2026-06-04-ora-pm-design.md`
