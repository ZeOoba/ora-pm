import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { TrueUpConfirmDescription } from '../../src/pages/cam/TrueUpConfirmDescription'

// The Approve & Bill confirm copy must match what POST /cam/:id/approve actually does:
//   > 0 -> posts a charge; < 0 -> marks billed, credit handled manually; === 0 -> server no-ops.
const render = (true_up_amount: number) =>
  renderToStaticMarkup(
    createElement(TrueUpConfirmDescription, {
      row: { true_up_amount, reconciliation_year: 2025, leases: { tenants: { name: 'Acme Test LLC' } } },
    }),
  )

describe('CAM true-up confirm copy', () => {
  it('positive amount: posts a charge for that amount', () => {
    const html = render(1234.5)
    expect(html).toContain('Posts a')
    expect(html).toContain('$1,234.50')
    expect(html).toContain('Acme Test LLC')
  })

  it('negative amount: credit, nothing posted', () => {
    const html = render(-200)
    expect(html).toContain('owed a credit')
    expect(html).toContain('$200.00')
    expect(html).toContain('nothing is posted to the ledger')
  })

  it('zero amount: says nothing will be posted, never "Posts a $0.00 true-up charge"', () => {
    const html = render(0)
    expect(html).not.toContain('Posts a')
    expect(html).not.toContain('$0.00')
    expect(html).toMatch(/balanced/i)
    expect(html).toContain('nothing will be posted')
    expect(html).toContain('Acme Test LLC')
  })

  it('CAMList renders the dialog description through TrueUpConfirmDescription', () => {
    const src = readFileSync(new URL('../../src/pages/cam/CAMList.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/<TrueUpConfirmDescription row=\{dialogRow\} \/>/)
  })
})
