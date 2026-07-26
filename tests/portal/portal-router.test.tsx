import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { PortalRouter } from '../../src/portal/PortalRouter'

vi.mock('../../src/portal/lib/supabase-portal', () => ({
  portalSupabase: {
    auth: {
      signInWithOtp: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
}))

// PortalRouter is mounted at src/router.tsx under the '/portal/*' path, so when
// PortalApp renders it, the browser location is the full '/portal/login' — not
// a relative remainder. Route paths here must therefore be relative to that
// mount point ('login', not '/portal/login'), matching how a nested <Routes>
// resolves paths against its ancestor route's pathnameBase.
describe('PortalRouter', () => {
  it('renders the login form at /portal/login', () => {
    // Mirrors src/router.tsx: PortalRouter is mounted as the element of an
    // ancestor route matched at '/portal/*', not rendered at the tree root.
    const router = createMemoryRouter(
      [{ path: '/portal/*', element: createElement(PortalRouter, { session: null }) }],
      { initialEntries: ['/portal/login'] }
    )
    const markup = renderToStaticMarkup(createElement(RouterProvider, { router }))

    expect(markup).toContain('Tenant Portal')
    expect(markup).toContain('Send sign-in link')
  })
})
