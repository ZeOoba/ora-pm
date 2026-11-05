import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ReactQuery from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}))

// Mocked useQuery results keyed by the first queryKey segment (mutations stay real).
const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) => results.current[String(opts.queryKey[0])],
}))

import { PropertyDetail } from '../../src/pages/properties/PropertyDetail'
import { TenantDetail } from '../../src/pages/tenants/TenantDetail'
import { LeaseDetail } from '../../src/pages/leases/LeaseDetail'
import { sortTimeline } from '../../src/components/timeline'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const loading = () => ({ isPending: true, isLoading: true, isError: false, error: null, data: undefined, refetch: vi.fn() })
const failed = (msg: string) => ({ isPending: false, isLoading: false, isError: true, error: new Error(msg), data: undefined, refetch: vi.fn() })

function render(path: string, route: string, Page: () => React.JSX.Element) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(Routes, null, createElement(Route, { path: route, element: createElement(Page) })),
      ),
    ),
  )
}

const property = {
  id: 'p1', name: 'Acme Test Park', address: '1 Test Way', city: 'Testville', state: 'OH', zip: '43000',
  property_type: 'industrial', total_sf: 50000, entity_llc: 'Acme Test LLC', notes: null,
  units: [
    { id: 'u1', property_id: 'p1', suite: '101', floor: null, sf: 1000, status: 'occupied' },
    { id: 'u2', property_id: 'p1', suite: '102', floor: null, sf: 500, status: 'vacant' },
  ],
}
const tenant = {
  id: 't1', name: 'Acme Test LLC', contact_name: 'Pat Test', contact_email: 'pat@example.test', contact_phone: null,
  auth_user_id: null, notes: null,
  leases: [{ id: 'l1', status: 'active', base_rent_monthly: 1000, end_date: '2027-01-31', units: { suite: '101', properties: { name: 'Acme Test Park' } } }],
  insurance_certificates: [{ id: 'c1', policy_type: 'general_liability', carrier: 'X', coverage_amount: 1, expiration_date: '2026-01-01', status: 'expired' }],
  correspondence_log: [
    { id: 'e1', direction: 'inbound', contact_date: '2026-01-02', subject: 'Older call', summary: 's', method: 'phone' },
    { id: 'e2', direction: 'outbound', contact_date: '2026-03-04', subject: 'Newer email', summary: 's', method: 'email' },
  ],
}
const lease = {
  id: 'l1', status: 'active', rent_type: 'nnn', start_date: '2025-01-01', end_date: '2027-01-31',
  base_rent_monthly: 1200, cam_estimate_monthly: 100, security_deposit: 1200, ti_allowance: null, expense_stop_amount: null,
  tenants: { name: 'Acme Test LLC' }, units: { suite: '101', sf: 1000, properties: { name: 'Acme Test Park' } },
  lease_amendments: [{ id: 'a1', description: 'Rent bump', effective_date: '2026-02-01' }],
  tenant_notices: [{ id: 'n1', notice_type: 'late_payment', sent_date: '2026-05-01', method: 'email', notes: null }],
  lease_documents: [], broker_commissions: [],
}

describe('entity detail pages', () => {
  it('PropertyDetail renders Overview / Units / Leases tabs and KPIs', () => {
    results.current = { property: ok(property), 'rent-roll': ok([]), units: ok(property.units) }
    const html = render('/properties/p1', '/properties/:id', PropertyDetail)
    for (const t of ['Overview', 'Units', 'Leases']) expect(html).toContain(`>${t}</button>`)
    expect(html).toContain('Acme Test Park')
    expect(html).toContain('1 of 2')
    expect(html).toContain('Property Summary')
  })

  it('TenantDetail renders its five tabs and the correspondence timeline newest first', () => {
    results.current = { tenant: ok(tenant) }
    const html = render('/tenants/t1', '/tenants/:id', TenantDetail)
    for (const t of ['Overview', 'Leases', 'Insurance', 'Correspondence', 'Portal']) expect(html).toContain(`>${t}</button>`)
    expect(html.indexOf('Newer email')).toBeGreaterThan(-1)
    expect(html.indexOf('Newer email')).toBeLessThan(html.indexOf('Older call'))
  })

  it('LeaseDetail renders its five tabs', () => {
    results.current = { lease: ok(lease) }
    const html = render('/leases/l1', '/leases/:id', LeaseDetail)
    for (const t of ['Terms', 'Amendments', 'Notices', 'Documents', 'Commissions']) expect(html).toContain(`>${t}</button>`)
    expect(html).toContain('Acme Test LLC')
  })

  it.each([
    ['PropertyDetail', '/properties/p1', '/properties/:id', PropertyDetail, 'property'],
    ['TenantDetail', '/tenants/t1', '/tenants/:id', TenantDetail, 'tenant'],
    ['LeaseDetail', '/leases/l1', '/leases/:id', LeaseDetail, 'lease'],
  ] as const)('%s shows a skeleton while loading and an error banner on failure', (_n, path, route, Page, key) => {
    results.current = { [key]: loading(), 'rent-roll': loading() }
    expect(render(path, route, Page)).toContain('aria-busy="true"')
    results.current = { [key]: failed(`boom ${key}`), 'rent-roll': loading() }
    const html = render(path, route, Page)
    expect(html).toContain('role="alert"')
    expect(html).toContain(`boom ${key}`)
  })
})

describe('sortTimeline', () => {
  it('orders newest first and keeps ties stable without mutating the input', () => {
    const input = [
      { date: '2026-01-01', label: 'a' },
      { date: '2026-03-01', label: 'b' },
      { date: '2026-03-01', label: 'c' },
    ]
    expect(sortTimeline(input).map((i) => i.label)).toEqual(['b', 'c', 'a'])
    expect(input.map((i) => i.label)).toEqual(['a', 'b', 'c'])
  })
})

// The refactor moved forms into Sheets but must not change what they send.
describe('mutations on the detail pages are unchanged', () => {
  const src = (p: string) => readFileSync(join(__dirname, `../../src/pages/${p}`), 'utf-8')

  it('PropertyDetail add-unit', () => {
    const s = src('properties/PropertyDetail.tsx')
    expect(s).toMatch(/useSaveMutation<Unit>\(\{\s*method: 'post',\s*path: '\/units',\s*invalidate: \[\['units', id \?\? ''\], \['property', id \?\? ''\]\],/)
    expect(s).toMatch(/const EMPTY_UNIT: UnitForm = \{\s*suite: '',\s*floor: '',\s*sf: '',\s*status: 'vacant',\s*\}/)
    expect(s).toContain('useState<UnitForm>(EMPTY_UNIT)')
    expect(s).toMatch(/property_id: id,\s*suite: unitForm\.suite\.trim\(\),\s*floor: unitForm\.floor\.trim\(\) \|\| null,\s*sf: Number\(unitForm\.sf\),\s*status: unitForm\.status,/)
  })

  it('PropertyDetail reads the per-property rent roll', () => {
    const s = src('properties/PropertyDetail.tsx')
    expect(s).toContain("queryKey: ['rent-roll', id]")
    expect(s).toContain('/reports/rent-roll?property_id=${id}')
  })

  it('LeaseDetail amendments', () => {
    const s = src('leases/LeaseDetail.tsx')
    expect(s).toMatch(/useSaveMutation<LeaseAmendment>\(\{\s*method: 'post',\s*path: `\/leases\/\$\{id\}\/amendments`,\s*invalidate: \[\['lease', id \?\? ''\]\],/)
    expect(s).toMatch(/const EMPTY_AMENDMENT: AmendmentForm = \{\s*effective_date: '',\s*description: '',\s*document_path: '',\s*\}/)
    expect(s).toContain('useState<AmendmentForm>(EMPTY_AMENDMENT)')
    expect(s).toMatch(/effective_date: amendForm\.effective_date,\s*description: amendForm\.description\.trim\(\),\s*document_path: amendForm\.document_path\.trim\(\) \|\| null,\s*changes: \{\},/)
  })

  it('LeaseDetail notices', () => {
    const s = src('leases/LeaseDetail.tsx')
    expect(s).toMatch(/useSaveMutation<TenantNotice>\(\{\s*method: 'post',\s*path: `\/leases\/\$\{leaseId\}\/notices`,\s*invalidate: \[\['lease', leaseId\]\],/)
    expect(s).toMatch(/useState\(\{ notice_type: 'late_payment', sent_date: new Date\(\)\.toISOString\(\)\.slice\(0,10\), method: 'email', notes: '' \}\)/)
    expect(s).toContain('noticeMutation.mutate(form)')
  })

  it('TenantDetail correspondence and the portal admin component', () => {
    const s = src('tenants/TenantDetail.tsx')
    expect(s).toMatch(/useSaveMutation<CorrespondenceEntry>\(\{\s*method: 'post',\s*path: `\/tenants\/\$\{tenantId\}\/correspondence`,\s*invalidate: \[\['tenant', tenantId\]\],/)
    expect(s).toMatch(/useState\(\{\s*direction: 'outbound', contact_date: new Date\(\)\.toISOString\(\)\.slice\(0,10\),\s*subject: '', summary: '', method: 'phone',\s*\}\)/)
    expect(s).toContain('mutation.mutate(form)')
    expect(s).toContain('<TenantPortalAdmin tenant={data} />')
  })
})
