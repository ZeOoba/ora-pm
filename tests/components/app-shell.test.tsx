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

// The rail's collapsed state is read from localStorage in the useState initializer, so the very
// first render is already collapsed (no expanded-then-collapsed flash after an effect).
describe('AppShell collapsed rail (first render)', () => {
  function withStorage(storage: unknown, fn: () => void) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
    const prev = (globalThis as { localStorage?: unknown }).localStorage
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
    try {
      fn()
    } finally {
      if (had) Object.defineProperty(globalThis, 'localStorage', { value: prev, configurable: true, writable: true })
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  }

  it('renders collapsed on the first render when storage says so', () => {
    withStorage({ getItem: () => '1', setItem: () => {} }, () => {
      const html = render('/leases')
      expect(html).toContain('aria-label="Expand navigation"')
      expect(html).not.toContain('aria-label="Collapse navigation"')
    })
  })

  it('renders expanded when storage throws (private mode)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
    }
    withStorage(throwing, () => {
      expect(render('/leases')).toContain('aria-label="Collapse navigation"')
    })
  })
})
