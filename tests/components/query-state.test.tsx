import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { QueryState } from '../../src/components/QueryState'
import { queryStateOf, staleErrors, type QueryLike } from '../../src/components/query-state'

const q = (over: Partial<QueryLike> = {}): QueryLike => ({
  isPending: false, isError: false, error: null, data: [1], refetch: vi.fn(), ...over,
})

describe('queryStateOf', () => {
  it('error wins over loading (one first-load failure is enough to show the banner)', () => {
    expect(queryStateOf([q({ isPending: true }), q({ isError: true, error: new Error('x'), data: undefined })])).toBe('error')
  })
  it('a failed refetch that kept data does not block (ready)', () => {
    expect(queryStateOf(q({ isError: true, error: new Error('x'), data: [1] }))).toBe('ready')
  })
  it('mixed: one first-load error plus one query with data is blocking', () => {
    expect(queryStateOf([
      q({ isError: true, error: new Error('x'), data: [1] }),
      q({ isError: true, error: new Error('y'), data: undefined }),
    ])).toBe('error')
  })
  it('staleErrors lists only errored queries that still hold data', () => {
    const stale = q({ isError: true, error: new Error('x'), data: [1] })
    const first = q({ isError: true, error: new Error('y'), data: undefined })
    expect(staleErrors([stale, first, q()])).toEqual([stale])
  })
  it('loading when any query is pending and none failed', () => {
    expect(queryStateOf([q(), q({ isPending: true, data: undefined })])).toBe('loading')
  })
  it('empty only for a single query whose data is an empty array (default predicate)', () => {
    expect(queryStateOf(q({ data: [] }))).toBe('empty')
    expect(queryStateOf(q({ data: [] }), () => false)).toBe('ready')
    expect(queryStateOf(q({ data: { rows: [] } }), (d) => (d as { rows: unknown[] }).rows.length === 0)).toBe('empty')
    expect(queryStateOf([q({ data: [] }), q({ data: [] })])).toBe('ready')
  })
  it('ready otherwise', () => {
    expect(queryStateOf([q(), q()])).toBe('ready')
  })
})

describe('<QueryState>', () => {
  const render = (props: Parameters<typeof QueryState>[0]) => renderToStaticMarkup(createElement(QueryState, props))

  it('renders an alert banner with the error message and a Retry button', () => {
    const html = render({ query: q({ isError: true, error: new Error('Failed to load AR aging report'), data: undefined }), children: createElement('p', null, 'DATA') })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Failed to load AR aging report')
    expect(html).toContain('Retry')
    expect(html).not.toContain('DATA')
  })
  it('error with data: renders children plus a non-blocking warning with Retry', () => {
    const html = render({ query: q({ isError: true, error: new Error('boom'), data: [1] }), children: createElement('p', null, 'DATA') })
    expect(html).toContain('DATA')
    expect(html).toContain('Couldn&#x27;t refresh')
    expect(html).toContain('showing last loaded data')
    expect(html).toContain('Retry')
    expect(html).not.toContain('role="alert"')
  })
  it('mixed first-load error and data query: blocking error, no children', () => {
    const html = render({
      query: [q({ isError: true, error: new Error('first-load'), data: undefined }), q({ isError: true, error: new Error('stale'), data: [1] })],
      children: 'DATA',
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('first-load')
    expect(html).not.toContain('DATA')
  })
  it('renders skeletons while loading', () => {
    const html = render({ query: q({ isPending: true, data: undefined }), children: 'DATA' })
    expect(html).toContain('data-slot="skeleton"')
    expect(html).not.toContain('DATA')
  })
  it('renders the empty node for an empty result', () => {
    expect(render({ query: q({ data: [] }), empty: 'NOTHING', children: 'DATA' })).toContain('NOTHING')
  })
  it('renders children when ready', () => {
    expect(render({ query: q(), children: 'DATA' })).toContain('DATA')
  })
})
