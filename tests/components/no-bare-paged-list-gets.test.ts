import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Paged list endpoints default to 50 rows. A picker/selector that calls them with a bare
// api.get (typed or untyped) silently truncates at 50 -- use api.listAll (pages through
// everything) or api.list with explicit limit/offset. Detail routes (/tenants/${id}) are fine,
// and so is a DataTable `fetchPage` callback (DataTable always passes limit/offset).
const PAGED = ['tenants', 'properties', 'leases', 'charges', 'payments', 'expenses']
const BARE = new RegExp(`api\\.get(?:<[^(]*?>)?\\(\\s*[\`'"]/(?:${PAGED.join('|')})(?:[?'"\`]|\\$\\{|$)`, 'g')

/** Offending call sites in `src`, skipping matches on a DataTable fetchPage line. */
function bareCalls(src: string): string[] {
  const hits: string[] = []
  for (const m of src.matchAll(BARE)) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const lineEnd = src.indexOf('\n', m.index)
    const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    if (/\bfetchPage\b/.test(line)) continue
    hits.push(line.trim())
  }
  return hits
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []
  })
}

describe('no bare api.get to paged list endpoints anywhere in src/', () => {
  const files = walk(join(__dirname, '../../src'))

  it.each([
    ["typed list call", "api.get<{ data: T[] }>('/tenants')"],
    ["typed list call with a query", "api.get<{ data: T[] }>('/leases?status=active')"],
    ["untyped list call", "api.get('/tenants')"],
    ["untyped, double quotes", 'api.get("/properties")'],
    ["untyped template with a query", 'api.get(`/payments?lease_id=${id}`)'],
    ["template with an interpolated query string", 'api.get(`/charges${qs}`)'],
    ["multi-line generic", "api.get<{\n  data: Lease[]\n}>(\n  '/leases',\n)"],
  ])('the matcher flags a %s', (_name, code) => {
    expect(bareCalls(code)).toHaveLength(1)
  })

  it.each([
    ["typed detail route", 'api.get<{ data: T }>(`/tenants/${id}`)'],
    ["untyped detail route", "api.get('/properties/' + id)"],
    ["an unrelated endpoint with a shared prefix", "api.get('/leases-summary')"],
    ["api.listAll", "api.listAll<Tenant>('/tenants')"],
    ["a DataTable fetchPage caller", "fetchPage={(p) => api.get(`/tenants?limit=${p.limit}`)}"],
  ])('the matcher ignores %s', (_name, code) => {
    expect(bareCalls(code)).toEqual([])
  })

  it('scans all of src/, not only src/pages', () => {
    const rel = files.map((f) => f.split(/[\\/]src[\\/]/)[1].replace(/\\/g, '/'))
    expect(rel.some((f) => f.startsWith('components/'))).toBe(true)
    expect(rel.some((f) => f.startsWith('lib/'))).toBe(true)
    expect(rel.some((f) => f.startsWith('pages/'))).toBe(true)
  })

  for (const file of files) {
    it(file.split(/[\\/]src[\\/]/)[1], () => {
      expect(bareCalls(readFileSync(file, 'utf-8'))).toEqual([])
    })
  }
})

// F-012: the payments lease picker must page through EVERY active lease (api.listAll), filtered
// server-side to status=active -- not a 50-row bare get or an unfiltered list.
describe('PaymentsList lease picker (F-012)', () => {
  const src = readFileSync(join(__dirname, '../../src/pages/payments/PaymentsList.tsx'), 'utf-8')
  it("calls api.listAll('/leases', { status: 'active' })", () => {
    expect(src).toMatch(/api\.listAll(?:<[^>(]*>)?\(\s*'\/leases',\s*\{\s*status:\s*'active'\s*\}\s*\)/)
  })
  it('feeds the picker from that query', () => {
    expect(src).toMatch(/queryKey: \['leases', 'active', 'picker'\],\s*queryFn: \(\) =>\s*api\.listAll</)
  })
})
