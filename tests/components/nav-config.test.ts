import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAV_GROUPS, flatNavItems, breadcrumbFor } from '../../src/components/nav-config'

// Route paths declared in src/router.tsx (parsed from source: importing the module would
// build a browser router and pull in every page).
const routerSrc = readFileSync(join(__dirname, '../../src/router.tsx'), 'utf-8')
const ROUTE_PATHS = new Set([...routerSrc.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]))

describe('nav-config', () => {
  it('has the five specified groups', () => {
    expect(NAV_GROUPS.map((g) => g.heading)).toEqual(['Home', 'Portfolio', 'Leasing', 'Accounting', 'Reports'])
  })

  it('every nav `to` is a real route in the router', () => {
    for (const item of flatNavItems()) expect(ROUTE_PATHS.has(item.to), item.to).toBe(true)
  })

  it('has no duplicate destinations or labels', () => {
    const tos = flatNavItems().map((i) => i.to)
    const labels = flatNavItems().map((i) => i.label)
    expect(new Set(tos).size).toBe(tos.length)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('every item has a label and an icon', () => {
    for (const i of flatNavItems()) {
      expect(i.label.length).toBeGreaterThan(0)
      expect(i.icon).toBeTruthy()
    }
  })

  it('derives breadcrumbs from the pathname', () => {
    expect(breadcrumbFor('/')).toEqual([{ label: 'Home', to: '/' }])
    expect(breadcrumbFor('/leases')).toEqual([{ label: 'Portfolio' }, { label: 'Leases', to: '/leases' }])
    expect(breadcrumbFor('/leases/abc-123')).toEqual([
      { label: 'Portfolio' },
      { label: 'Leases', to: '/leases' },
      { label: 'Detail' },
    ])
    expect(breadcrumbFor('/properties/new')).toEqual([
      { label: 'Portfolio' },
      { label: 'Properties', to: '/properties' },
      { label: 'New' },
    ])
    expect(breadcrumbFor('/leases/abc/edit')).toEqual([
      { label: 'Portfolio' },
      { label: 'Leases', to: '/leases' },
      { label: 'Detail' },
      { label: 'Edit' },
    ])
  })

  it('falls back to an empty trail for unknown paths', () => {
    expect(breadcrumbFor('/nope')).toEqual([])
  })
})
