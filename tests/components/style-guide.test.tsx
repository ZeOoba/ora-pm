import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StyleGuide } from '../../src/pages/StyleGuide'

describe('StyleGuide', () => {
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(StyleGuide)),
  )

  it('is labelled P1 design system and shows the corrected parchment swatch', () => {
    expect(html).toContain('P1 design system')
    expect(html).toContain('#F5F3EF')
    expect(html).not.toContain('#F5F0E8')
  })

  it('shows the new primitives with fake data only', () => {
    for (const text of ['Open dialog', 'Open sheet', 'Success toast', 'Acme Test LLC', 'SF occupancy', 'Portfolio aging', 'Overview'])
      expect(html).toContain(text)
  })
})
