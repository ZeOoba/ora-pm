import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  },
}))

import { AppShell } from '../../src/components/AppShell'
import { flatNavItems } from '../../src/components/nav-config'

function render(path: string) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(AppShell, null, createElement('p', null, 'BODY'))),
    ),
  )
}

describe('AppShell', () => {
  const html = render('/leases')

  it('renders every nav label in the rail', () => {
    for (const { label } of flatNavItems()) expect(html).toContain(label)
  })

  it('renders group headings', () => {
    for (const h of ['Portfolio', 'Leasing', 'Accounting', 'Reports']) expect(html).toContain(h)
  })

  it('uses md: responsive classes (rail >= md, top bar < md)', () => {
    expect(html).toMatch(/<aside class="hidden[^"]*md:flex/)
    expect(html).toMatch(/md:hidden/)
    expect(html).toContain('p-4 md:p-8')
  })

  it('renders children, the search hint, and the breadcrumb', () => {
    expect(html).toContain('BODY')
    expect(html).toMatch(/Ctrl K|⌘K/)
    expect(html).toContain('aria-label="Breadcrumb"')
  })

  it('marks the active route', () => {
    expect(html).toContain('aria-current="page"')
  })
})
