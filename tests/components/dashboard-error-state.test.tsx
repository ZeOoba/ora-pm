import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import type * as ReactQuery from '@tanstack/react-query'

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}))

// Mocked query results keyed by the first queryKey segment.
const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) => results.current[String(opts.queryKey[0])],
}))

import { Dashboard } from '../../src/pages/Dashboard'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const failed = (msg: string) => ({ isPending: false, isLoading: false, isError: true, error: new Error(msg), data: undefined, refetch: vi.fn() })
const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Dashboard)))

describe('Dashboard error state', () => {
  it('shows the error banner (not $0 KPIs) when the AR query fails', () => {
    results.current = { 'rent-roll': ok([]), 'critical-dates': ok([]), 'ar-aging': failed('Failed to load AR aging report') }
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain('Failed to load AR aging report')
    expect(html).not.toContain('Outstanding AR')
    expect(html).not.toContain('Portfolio is healthy')
  })

  it.each(['rent-roll', 'critical-dates'])('shows the banner when %s fails', (key) => {
    results.current = { 'rent-roll': ok([]), 'critical-dates': ok([]), 'ar-aging': ok([]), [key]: failed(`boom ${key}`) }
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain(`boom ${key}`)
  })

  it('renders KPIs when every query succeeds', () => {
    results.current = { 'rent-roll': ok([]), 'critical-dates': ok([]), 'ar-aging': ok([]) }
    const html = render()
    expect(html).not.toContain('role="alert"')
    expect(html).toContain('Outstanding AR')
  })
})
