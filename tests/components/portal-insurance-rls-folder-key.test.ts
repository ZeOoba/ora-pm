import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PortalInsurance } from '../../src/portal/pages/PortalInsurance'

// OI-071: PortalInsurance uploaded COIs to insurance-certs/<auth.uid()>/<file>,
// but the storage RLS policy `tenant_upload_insurance`
// (supabase/migrations/0008_storage_rls.sql) requires the first folder segment
// to equal public.tenants.id for the row whose auth_user_id = auth.uid() — a
// DIFFERENT uuid. Every real tenant upload therefore failed RLS. The fix keys
// the folder on meData.tenant.id from GET /api/portal/me (the same query
// PortalPayNow/PortalDashboard already use), never on session.user.id.
//
// No React-rendering test harness exists in this repo — no jsdom environment,
// no @testing-library/react (see vitest.config.ts's `environment: 'node'` and
// package.json's devDependencies) — so the upload-path derivation is verified
// by reading the component source, matching the established pattern in
// portal-paynow-client-request-id.test.ts / portal-account-autopay-error-handling.test.ts.
// The "meData not yet loaded" guard IS render-observable without a DOM
// (react-dom/server + TanStack Query renders the initial pending state), so
// that part is asserted behaviorally below.

vi.mock('../../src/portal/lib/supabase-portal', () => ({
  portalSupabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    storage: { from: vi.fn(() => ({ upload: vi.fn() })) },
  },
}))

vi.mock('../../src/portal/lib/portal-api', () => ({
  portalApi: { getMe: vi.fn() },
}))

describe('PortalInsurance — storage folder key must be tenants.id, not auth.uid() (OI-071)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalInsurance.tsx'),
    'utf-8'
  )

  it('loads the tenant profile via the shared portal-me query', () => {
    expect(source).toMatch(/import\s*\{[^}]*\buseQuery\b[^}]*\}\s*from\s*['"]@tanstack\/react-query['"]/)
    expect(source).toMatch(/import\s*\{\s*portalApi\s*\}\s*from\s*['"]\.\.\/lib\/portal-api['"]/)
    expect(source).toMatch(/useQuery\(\{\s*queryKey:\s*\['portal-me'\],\s*queryFn:\s*portalApi\.getMe\s*\}\)/)
  })

  it('derives the upload folder from meData.tenant.id', () => {
    expect(source).toMatch(/const tenantId = meData\?\.tenant\.id/)
    expect(source).toMatch(/const fileName = `\$\{tenantId\}\/\$\{file\.name\}`/)
    expect(source).toMatch(/\.from\('insurance-certs'\)\s*\.upload\(fileName, file/)
  })

  it('never uses the Supabase auth user id (session.user.id) anywhere in the component code', () => {
    // Strip // line comments first: the component is allowed to EXPLAIN the
    // bug in a comment; it just may not use the auth user id in code.
    const code = source.replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/session\.user\.id/)
    expect(code).not.toMatch(/session\.user\b/)
  })

  it('refuses to submit (before any upload) when the tenant profile has not loaded', () => {
    // The guard must sit between the tenantId derivation and the storage upload,
    // so an undefined id can never reach `.upload(...)` as "undefined/<file>".
    const tenantIdIdx = source.indexOf('const tenantId = meData?.tenant.id')
    const guardIdx = source.search(/if\s*\(!tenantId\)\s*\{[^}]*return\s*\}/)
    const uploadIdx = source.indexOf(".from('insurance-certs')")
    expect(tenantIdIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(tenantIdIdx)
    expect(uploadIdx).toBeGreaterThan(guardIdx)
  })

  it('renders the submit button disabled while the tenant profile is still loading', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(PortalInsurance))
    )
    // Initial render: useQuery is pending, meData is undefined — the submit
    // control must be disabled and say so, matching PortalPayNow's
    // `if (!meData?.tenant) return` convention made visible.
    const submitButton = markup.match(/<button[^>]*type="submit"[^>]*>[^<]*<\/button>/)?.[0]
    expect(submitButton).toBeDefined()
    expect(submitButton).toMatch(/\bdisabled=""/)
    expect(submitButton).not.toMatch(/Submit Certificate/)
  })
})
