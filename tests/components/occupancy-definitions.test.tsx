import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { OccupancyDonut } from '../../src/components/charts/OccupancyDonut'

describe('occupancy metric definitions', () => {
  it('OccupancyDonut states the SF occupancy definition visibly', () => {
    const html = renderToStaticMarkup(createElement(OccupancyDonut, { split: { occupiedSf: 10, vacantSf: 5 } as never }))
    expect(html).toContain('occupied + notice SF')
    expect(html).toContain('excluding unavailable units')
  })
  it('Dashboard states the unit occupancy definition', () => {
    const src = readFileSync(join(__dirname, '../../src/pages/Dashboard.tsx'), 'utf-8')
    expect(src).toContain('occupied units ÷ all units')
  })
})
