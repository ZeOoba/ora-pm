// tests/routes/list-query.test.ts
//
// parseListQuery: shared limit/offset/sort/dir/q parsing for the paged list
// endpoints. `q` feeds a PostgREST `.or()` filter string, so the escaping is
// security-relevant: a user-controlled `q` must never be able to add filter
// clauses (commas / parentheses) or smuggle LIKE wildcards.

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { parseListQuery, buildSearchFilter } from '../../server/lib/list-query'

const SORTABLE = ['name', 'city', 'created_at'] as const
const SEARCH = ['name', 'city', 'entity_llc'] as const

type ParsedBody = {
  limit: number
  offset: number
  sort: string
  ascending: boolean
  q?: string
  searchFilter: string
  error?: string
}

function run(
  qs: string,
  opts: Partial<Parameters<typeof parseListQuery>[1]> = {},
): Promise<{ status: number; body: ParsedBody }> {
  const app = new Hono()
  app.get('/', (c) => {
    const lq = parseListQuery(c, { sortable: SORTABLE, defaultSort: 'name', searchColumns: SEARCH, ...opts })
    return c.json(lq)
  })
  return Promise.resolve(app.request(`/${qs}`)).then(async (res) => ({ status: res.status, body: await res.json() }))
}

// Split a PostgREST or-filter on commas that are NOT inside a double-quoted value.
function splitClauses(filter: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < filter.length; i++) {
    const ch = filter[i]
    if (inQuote && ch === '\\') {
      cur += ch + filter[i + 1]
      i++
      continue
    }
    if (ch === '"') inQuote = !inQuote
    if (ch === ',' && !inQuote) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

describe('parseListQuery', () => {
  it('applies defaults', async () => {
    const { status, body } = await run('')
    expect(status).toBe(200)
    expect(body).toMatchObject({ limit: 50, offset: 0, sort: 'name', ascending: true, searchFilter: null })
    expect(body.q).toBeUndefined()
  })

  it('honours defaultDir when dir is absent, and an explicit dir overrides it', async () => {
    expect((await run('', { defaultDir: 'desc' })).body.ascending).toBe(false)
    expect((await run('?dir=asc', { defaultDir: 'desc' })).body.ascending).toBe(true)
  })

  it('parses limit/offset/sort/dir', async () => {
    const { body } = await run('?limit=25&offset=100&sort=city&dir=desc')
    expect(body).toMatchObject({ limit: 25, offset: 100, sort: 'city', ascending: false })
  })

  it('rejects a sort field not in the allow-list with 422', async () => {
    const { status, body } = await run('?sort=password_hash')
    expect(status).toBe(422)
    expect(body).toEqual({ error: 'Invalid sort field' })
  })

  it('rejects a sort value that tries to inject PostgREST syntax', async () => {
    expect((await run('?sort=name.desc,id')).status).toBe(422)
  })

  it('rejects limit > 200, limit < 1, negative offset and bad dir with 422', async () => {
    expect((await run('?limit=201')).status).toBe(422)
    expect((await run('?limit=0')).status).toBe(422)
    expect((await run('?offset=-1')).status).toBe(422)
    expect((await run('?dir=sideways')).status).toBe(422)
  })

  it('trims q and ignores empty q', async () => {
    expect((await run('?q=%20%20')).body.searchFilter).toBeNull()
    expect((await run('?q=%20acme%20')).body.q).toBe('acme')
  })

  it('rejects q longer than 100 chars', async () => {
    expect((await run(`?q=${'a'.repeat(101)}`)).status).toBe(422)
  })

  it('builds one ilike clause per search column', async () => {
    const { body } = await run('?q=acme')
    expect(splitClauses(body.searchFilter)).toEqual([
      'name.ilike."%acme%"',
      'city.ilike."%acme%"',
      'entity_llc.ilike."%acme%"',
    ])
  })

  it('gives no searchFilter when the route has no searchColumns', async () => {
    expect((await run('?q=acme', { searchColumns: undefined })).body.searchFilter).toBeNull()
  })
})

describe('buildSearchFilter escaping', () => {
  it('escapes LIKE wildcards % and _ (and backslash) so they match literally', () => {
    // LIKE-escape (\% \_ \\) then PostgREST quote-escape doubles each backslash.
    expect(buildSearchFilter('100%_done', ['name'])).toBe('name.ilike."%100\\\\%\\\\_done%"')
    expect(buildSearchFilter('a\\b', ['name'])).toBe('name.ilike."%a\\\\\\\\b%"')
  })

  it('keeps commas and parentheses inside the quoted value', () => {
    const f = buildSearchFilter('a,b(c)d', SEARCH)!
    expect(f).toContain('"%a,b(c)d%"')
    expect(splitClauses(f)).toHaveLength(SEARCH.length)
  })

  it('cannot inject extra filter clauses via commas/parens/quotes', () => {
    const evil = 'x%"),id.neq.0,(name.ilike."'
    const f = buildSearchFilter(evil, SEARCH)!
    const clauses = splitClauses(f)
    expect(clauses).toHaveLength(SEARCH.length)
    clauses.forEach((cl, i) => expect(cl.startsWith(`${SEARCH[i]}.ilike."%`)).toBe(true))
    clauses.forEach((cl) => expect(cl.endsWith('%"')).toBe(true))
  })

  it('strips * (PostgREST wildcard alias)', () => {
    expect(buildSearchFilter('a*b', ['name'])).toBe('name.ilike."%ab%"')
  })

  it('returns null for empty q or no columns', () => {
    expect(buildSearchFilter('', ['name'])).toBeNull()
    expect(buildSearchFilter('x', [])).toBeNull()
  })
})

describe('parseListQuery: control characters and empty dir', () => {
  it('rejects control characters (incl. NUL) in q with 422', async () => {
    for (const q of ['%00', 'a%00b', 'a%1Fb', 'a%0Ab', 'a%7Fb']) {
      expect((await run(`?q=${q}`)).status).toBe(422)
    }
  })
  it('empty dir= behaves like absent dir', async () => {
    expect((await run('?dir=', { defaultDir: 'desc' })).body.ascending).toBe(false)
    expect((await run('?dir=')).body.ascending).toBe(true)
  })
})
