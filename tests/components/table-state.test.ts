import { describe, it, expect, vi } from 'vitest'
import {
  toListParams,
  pageCount,
  rangeLabel,
  collectPages,
  clientPage,
  clientFilterSort,
  type TableState,
} from '../../src/components/data-table/table-state'

const base: TableState = { pageIndex: 0, pageSize: 50, filters: {} }

describe('toListParams', () => {
  it('maps page 3 of size 50 (pageIndex 2) to offset 100', () => {
    expect(toListParams({ ...base, pageIndex: 2 })).toMatchObject({ limit: 50, offset: 100 })
  })

  it('maps a descending sort to sort + dir desc', () => {
    expect(toListParams({ ...base, sort: { id: 'name', desc: true } })).toMatchObject({
      sort: 'name',
      dir: 'desc',
    })
  })

  it('maps an ascending sort to dir asc', () => {
    expect(toListParams({ ...base, sort: { id: 'name', desc: false } })).toMatchObject({
      sort: 'name',
      dir: 'asc',
    })
  })

  it('omits sort, dir and q when unset or empty', () => {
    const p = toListParams({ ...base, q: '' })
    expect(p).toEqual({ limit: 50, offset: 0 })
    expect('q' in p).toBe(false)
    expect('sort' in p).toBe(false)
    expect('dir' in p).toBe(false)
  })

  it('trims q and includes it when non-empty', () => {
    expect(toListParams({ ...base, q: '  acme ' }).q).toBe('acme')
  })

  it('spreads filters and drops empty filter values', () => {
    const p = toListParams({ ...base, filters: { status: 'active', property_id: '' } })
    expect(p.status).toBe('active')
    expect('property_id' in p).toBe(false)
  })
})

describe('pageCount', () => {
  it('rounds up', () => expect(pageCount(140, 50)).toBe(3))
  it('is at least 1 for an empty result', () => expect(pageCount(0, 50)).toBe(1))
  it('is exact on a boundary', () => expect(pageCount(100, 50)).toBe(2))
})

describe('rangeLabel', () => {
  it('formats the middle page', () => expect(rangeLabel(1, 50, 140)).toBe('Showing 51–100 of 140'))
  it('clamps the last page to total', () => expect(rangeLabel(2, 50, 140)).toBe('Showing 101–140 of 140'))
  it('handles empty', () => expect(rangeLabel(0, 50, 0)).toBe('Showing 0 of 0'))
})

describe('collectPages', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ i }))

  it('fetches sequentially at limit 200 until total is reached', async () => {
    const all = mk(450)
    const fetchPage = vi.fn(async (p: { limit: number; offset: number; q?: string }) => ({
      data: all.slice(p.offset, p.offset + p.limit),
      total: all.length,
    }))
    const res = await collectPages(fetchPage, { ...base, pageIndex: 3, q: 'x' })
    expect(res.rows).toHaveLength(450)
    expect(res.truncated).toBe(false)
    expect(fetchPage.mock.calls.map((c) => [c[0].limit, c[0].offset])).toEqual([
      [200, 0],
      [200, 200],
      [200, 400],
    ])
    expect(fetchPage.mock.calls[0][0].q).toBe('x')
  })

  it('stops at 2000 rows and reports truncation', async () => {
    const fetchPage = vi.fn(async (p: { limit: number; offset: number }) => ({
      data: mk(p.limit),
      total: 5000,
    }))
    const res = await collectPages(fetchPage, base)
    expect(res.rows).toHaveLength(2000)
    expect(res.truncated).toBe(true)
    expect(res.total).toBe(5000)
    expect(fetchPage).toHaveBeenCalledTimes(10)
  })

  it('stops on an empty page even if total is larger (defensive)', async () => {
    const fetchPage = vi.fn(async () => ({ data: [] as { i: number }[], total: 10 }))
    const res = await collectPages(fetchPage, base)
    expect(res.rows).toHaveLength(0)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })
})

describe('toListParams reserved keys', () => {
  it('ignores filters that collide with reserved keys', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = toListParams({
      ...base,
      pageIndex: 1,
      sort: { id: 'name', desc: false },
      q: 'x',
      filters: { limit: '999', offset: '7', sort: 'evil', dir: 'desc', q: 'y', status: 'open' },
    })
    expect(p).toMatchObject({ limit: 50, offset: 50, sort: 'name', dir: 'asc', q: 'x', status: 'open' })
    warn.mockRestore()
  })
})

describe('client mode helpers', () => {
  type R = { id: number; name: string; sf: number | null; status: string }
  const rows: R[] = [
    { id: 1, name: 'Bravo Test LLC', sf: 200, status: 'active' },
    { id: 2, name: 'alpha Test LLC', sf: null, status: 'expired' },
    { id: 3, name: 'Charlie Test LLC', sf: 50, status: 'active' },
    { id: 4, name: 'Delta Test LLC', sf: 100, status: 'active' },
  ]
  const base: TableState = { pageIndex: 0, pageSize: 2, filters: {} }
  const getSortValue = (r: R, id: string) => (r as unknown as Record<string, unknown>)[id]
  const searchFn = (r: R, q: string) => r.name.toLowerCase().includes(q.toLowerCase())

  it('paginates and reports the full filtered total', () => {
    const p = clientPage(rows, base, {})
    expect(p.data.map((r) => r.id)).toEqual([1, 2])
    expect(p.total).toBe(4)
    expect(clientPage(rows, { ...base, pageIndex: 1 }, {}).data.map((r) => r.id)).toEqual([3, 4])
  })

  it('searches with searchFn on the trimmed query and ignores blank q', () => {
    expect(clientPage(rows, { ...base, q: '  charlie ' }, { searchFn }).data.map((r) => r.id)).toEqual([3])
    expect(clientPage(rows, { ...base, q: '   ' }, { searchFn }).total).toBe(4)
  })

  it('sorts case-insensitively for strings and numerically, nulls last in both directions', () => {
    const byName = clientFilterSort(rows, { ...base, sort: { id: 'name', desc: false } }, { getSortValue })
    expect(byName.map((r) => r.id)).toEqual([2, 1, 3, 4])
    const asc = clientFilterSort(rows, { ...base, sort: { id: 'sf', desc: false } }, { getSortValue })
    expect(asc.map((r) => r.id)).toEqual([3, 4, 1, 2])
    const desc = clientFilterSort(rows, { ...base, sort: { id: 'sf', desc: true } }, { getSortValue })
    expect(desc.map((r) => r.id)).toEqual([1, 4, 3, 2])
  })

  it('applies filterFn with non-empty filter values only, before paging', () => {
    const filterFn = (r: R, f: Record<string, string>) => !f.status || r.status === f.status
    const p = clientPage(rows, { ...base, filters: { status: 'active' } }, { filterFn })
    expect(p.total).toBe(3)
    expect(clientPage(rows, { ...base, filters: { status: '' } }, { filterFn }).total).toBe(4)
  })

  it('does not mutate the input and clamps out-of-range pages to empty data with real total', () => {
    const copy = [...rows]
    clientFilterSort(rows, { ...base, sort: { id: 'name', desc: true } }, { getSortValue })
    expect(rows).toEqual(copy)
    const p = clientPage(rows, { ...base, pageIndex: 9 }, {})
    expect(p.data).toEqual([])
    expect(p.total).toBe(4)
  })
})
