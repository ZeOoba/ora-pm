import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '../../src/components/ui/Button'

describe('Button asChild', () => {
  it('renders the child element (an <a>) instead of a <button>', () => {
    const html = renderToStaticMarkup(
      <Button asChild variant="gold"><a href="/x">Go</a></Button>,
    )
    expect(html).toMatch(/^<a /)
    expect(html).toContain('href="/x"')
    expect(html).toContain('bg-gold')
    expect(html).not.toContain('<button')
  })
  it('renders a <button> by default and merges className', () => {
    const html = renderToStaticMarkup(<Button className="w-full">Hi</Button>)
    expect(html).toMatch(/^<button /)
    expect(html).toContain('bg-navy')
    expect(html).toContain('w-full')
  })
})
