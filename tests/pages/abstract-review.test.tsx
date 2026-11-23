import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/api', () => ({ api: { post: vi.fn() } }))
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AbstractReview, type AbstractResponse } from '../../src/pages/leases/AbstractReview'
import { confirmationKey, dayBefore, defaultLeaseNotes, setCited, REVIEWER_QUOTE, type LeaseAbstract } from '../../src/pages/leases/abstract-review-helpers'
import { reviewed } from '../fixtures/lease-abstract-approve'
import { confirmationKey as serverKey, REVIEWER_QUOTE_SUFFIX as SERVER_SUFFIX } from '../../server/lib/lease-abstract'

const result = (): AbstractResponse => JSON.parse(JSON.stringify(reviewed())) as AbstractResponse

function render(occupied: boolean) {
  const el = createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(MemoryRouter, null,
      createElement(AbstractReview, {
        result: result(), filename: 'Acme Lease.pdf', pdfBase64: 'JVBER', unitId: 'u1', unitLabel: 'Test Park · Suite 100',
        presetTenantId: '', tenants: [],
        occupants: occupied ? [{ id: 'old', start_date: '2022-01-01', end_date: '2027-12-31', status: 'active', tenant_name: 'Old Co' }] : [],
        onCancel: () => {},
      })))
  return renderToStaticMarkup(el)
}

describe('AbstractReview', () => {
  it('offers to replace the current tenant, defaults to a new tenant named from the lease, and blocks approval until values are confirmed', () => {
    const html = render(true)
    expect(html).toContain('Current tenant: <strong>Old Co</strong>')
    expect(html).toContain('Replace the current tenant with this lease')
    expect(html).toContain('value="2025-12-31"') // prior tenant's last day defaults to the day before commencement
    expect(html).toContain('value="Acme Fabrication LLC"')
    expect(html).toMatch(/Confirm billing values \(0\/\d+\)/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve &amp; import<\/button>/)
    expect(html).toContain('Renewal option')
  })

  it('a vacant unit shows no replace option', () => {
    const html = render(false)
    expect(html).toContain('Unit has no active or pending lease.')
    expect(html).not.toContain('Replace the current tenant')
  })
})

describe('abstract-review helpers', () => {
  it('default notes carry every term with no PM column (escalation, holdover, concessions, provisions with notice dates)', () => {
    const n = defaultLeaseNotes(JSON.parse(JSON.stringify(reviewed({ abatement: true }).abstract)) as LeaseAbstract, 'Acme Lease.pdf')
    expect(n).toContain('Abstracted from "Acme Lease.pdf".')
    expect(n).toContain('Escalation: 3% every 12 months from 2027-01-01.')
    expect(n).toContain('Holdover: 150% of rent then in effect.')
    expect(n).toContain('Concession (rent, 2026-01-01 to 2026-01-31): Abatement (50%).')
    expect(n).toContain('- Renewal option: One 5-year renewal option. Notice by 2028-06-30. (p. 3)')
  })
  it('a reviewer-entered value is marked in its quote and fully confident; clearing returns null', () => {
    expect(setCited('Acme Inc', null)).toEqual({ value: 'Acme Inc', page: 1, quote: REVIEWER_QUOTE('Acme Inc'), confidence: 1 })
    expect(setCited('', { value: 'x', page: 2, quote: 'q', confidence: 1 })).toBeNull()
  })
  it('a confirmation key changes when any confirmed input changes', () => {
    const c = result().confirmations[0]
    expect(confirmationKey(c)).toBe(confirmationKey({ ...c }))
    expect(confirmationKey(c)).not.toBe(confirmationKey({ ...c, monthly: (c.monthly ?? 0) + 1 }))
  })
  it('confirmation key and reviewer marker are byte-identical to the server (approval matches on them)', () => {
    for (const c of result().confirmations) expect(confirmationKey(c)).toBe(serverKey(c as Parameters<typeof serverKey>[0]))
    expect(REVIEWER_QUOTE('x')).toBe(`x${SERVER_SUFFIX}`)
  })
  it('dayBefore crosses month and year boundaries', () => {
    expect(dayBefore('2026-03-01')).toBe('2026-02-28')
    expect(dayBefore('2026-01-01')).toBe('2025-12-31')
  })
})
