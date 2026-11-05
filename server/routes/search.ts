import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client'
import { dbError } from '../lib/api-error'
import { buildSearchFilter } from '../lib/list-query'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export type SearchResult = {
  type: 'property' | 'tenant' | 'unit' | 'lease'
  id: string
  label: string
  sublabel: string
  href: string
}

const SearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .refine((v) => ![...v].some((ch) => { const n = ch.charCodeAt(0); return n < 0x20 || n === 0x7f }), {
      message: 'q must not contain control characters',
    }),
})

const PER_GROUP = 8
const TENANT_ID_SCAN = 50
const TOTAL_CAP = 20

// PostgREST embeds may come back as an object or a one-element array depending on inferred cardinality.
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

type Row = Record<string, unknown>

export const searchRouter = new Hono<{ Bindings: Env }>()

searchRouter.get('/', async (c) => {
  const parsed = SearchQuerySchema.safeParse({ q: c.req.query('q') })
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 422)
  const q = parsed.data.q
  const db = getDb(c.env)

  // Shared escaper from list-query.ts (LIKE-escape + PostgREST quoting).
  const nameFilter = buildSearchFilter(q, ['name'])
  const suiteFilter = buildSearchFilter(q, ['suite'])
  // A q made only of "*" cleans to nothing: no filter means no match.
  if (!nameFilter || !suiteFilter) return c.json({ data: [] })

  const [props, tenants, units] = await Promise.all([
    db.from('properties').select('id, name, city, state').or(nameFilter).order('name').limit(PER_GROUP),
    db.from('tenants').select('id, name').or(nameFilter).order('name').limit(TENANT_ID_SCAN),
    db.from('units').select('id, suite, property_id, properties(name)').or(suiteFilter).order('suite').limit(PER_GROUP),
  ])
  if (props.error) return dbError(c, props.error, 'Search failed')
  if (tenants.error) return dbError(c, tenants.error, 'Search failed')
  if (units.error) return dbError(c, units.error, 'Search failed')

  const tenantRows = (tenants.data ?? []) as Row[]
  let leaseRows: Row[] = []
  if (tenantRows.length > 0) {
    const leases = await db
      .from('leases')
      .select('id, tenants(name), units(suite, properties(name))')
      .in('tenant_id', tenantRows.map((t) => t.id as string))
      .limit(PER_GROUP)
    if (leases.error) return dbError(c, leases.error, 'Search failed')
    leaseRows = (leases.data ?? []) as Row[]
  }

  const results: SearchResult[] = [
    ...((props.data ?? []) as Row[]).slice(0, PER_GROUP).map((p): SearchResult => ({
      type: 'property',
      id: p.id as string,
      label: p.name as string,
      sublabel: [p.city, p.state].filter(Boolean).join(', '),
      href: `/properties/${p.id}`,
    })),
    ...tenantRows.slice(0, PER_GROUP).map((t): SearchResult => ({
      type: 'tenant',
      id: t.id as string,
      label: t.name as string,
      sublabel: '',
      href: `/tenants/${t.id}`,
    })),
    ...((units.data ?? []) as Row[]).slice(0, PER_GROUP).map((u): SearchResult => ({
      type: 'unit',
      id: u.id as string,
      label: u.suite as string,
      sublabel: one(u.properties as { name?: string } | { name?: string }[] | null)?.name ?? '',
      href: `/properties/${u.property_id}`,
    })),
    ...leaseRows.slice(0, PER_GROUP).map((l): SearchResult => {
      const unit = one(l.units as { suite?: string; properties?: unknown } | { suite?: string; properties?: unknown }[] | null)
      const prop = one(unit?.properties as { name?: string } | { name?: string }[] | null)
      return {
        type: 'lease',
        id: l.id as string,
        label: one(l.tenants as { name?: string } | { name?: string }[] | null)?.name ?? 'Lease',
        sublabel: [prop?.name, unit?.suite].filter(Boolean).join(' · '),
        href: `/leases/${l.id}`,
      }
    }),
  ].slice(0, TOTAL_CAP)

  return c.json({ data: results })
})
