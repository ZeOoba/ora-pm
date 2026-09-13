// tests/routes/core-forms-schema-drift.test.ts
//
// 2026-09-12: the Property / Tenant / Payment insert schemas used `.optional()`
// for nullable columns, but the admin forms send `null` for every blank
// optional field. Result:
//   - PropertyForm.tsx: blank total_sf / entity_llc / notes -> 422
//     ("Expected number/string, received null").
//   - TenantForm.tsx: blank contact_name / contact_email / contact_phone /
//     notes -> 422. A tenant with only a name could not be created.
//   - PaymentsList.tsx: `check_number` (a real column, 0002) was not in the
//     schema and, because the schema was not .strict(), was silently STRIPPED;
//     blank notes -> 422. Production had 0 payments rows.
// Also: properties.zip has been nullable since migration 0005 (the system of
// record carries no ZIP), but the schema rejected null and the form required it.
//
// Same fix shape as PR #33 (expenses): nullable columns `.nullish()`, missing
// real columns added, `.strict()` per OI-041 once each schema's key set equals
// the form payload exactly. VALID_* bodies below are the literal shapes the
// forms send; the drift guards re-derive those key sets from the component
// source and the migrations so a rename on either side fails here first.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '../../server/index'
import { PropertyInsertSchema, TenantInsertSchema, PaymentInsertSchema } from '../../server/lib/schemas'

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
}

const app = createApp()
beforeEach(() => vi.clearAllMocks())

function tableMock(spy: (row: unknown) => void) {
  const chain = {
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: { id: 'row_1' }, error: null }),
    }),
  }
  return {
    insert: vi.fn().mockImplementation((row: unknown) => { spy(row); return chain }),
    update: vi.fn().mockImplementation((row: unknown) => {
      spy(row)
      return { eq: vi.fn().mockReturnValue(chain) }
    }),
  }
}

function send(method: 'POST' | 'PUT', path: string, body: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

function expectWritten(spy: ReturnType<typeof vi.fn>, body: unknown) {
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy).toHaveBeenCalledWith(body)
}

// ---------------------------------------------------------------------------
// Properties — PropertyForm.tsx handleSubmit (POST create, PUT edit)
// ---------------------------------------------------------------------------

const PROPERTY_FILLED = {
  name: 'Westside Industrial Park',
  address: 'REDACTED-009',
  city: 'Columbus',
  state: 'OH',
  zip: '43224',
  property_type: 'industrial',
  total_sf: 42000,
  entity_llc: 'REDACTED-035 Holdings LLC',
  notes: 'Shallow-bay, 12 suites',
}

const PROPERTY_BLANK = {
  name: 'REDACTED-010',
  address: 'REDACTED-010',
  city: 'Columbia',
  state: 'MD',
  zip: null,
  property_type: 'industrial',
  total_sf: null,
  entity_llc: null,
  notes: null,
}

describe('POST /api/properties — PropertyForm.tsx payload', () => {
  it('inserts a fully filled form unchanged', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/properties', PROPERTY_FILLED)
    expect(res.status).toBe(201)
    expectWritten(spy, PROPERTY_FILLED)
  })

  it('accepts null zip / total_sf / entity_llc / notes (blank optional fields; zip nullable per 0005)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/properties', PROPERTY_BLANK)
    expect(res.status).toBe(201)
    expectWritten(spy, PROPERTY_BLANK)
  })

  it('still rejects a malformed zip and an empty-string zip (blank is sent as null, never "")', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    expect((await send('POST', '/api/properties', { ...PROPERTY_FILLED, zip: '4321' })).status).toBe(422)
    expect((await send('POST', '/api/properties', { ...PROPERTY_FILLED, zip: '' })).status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects unexpected fields (id, created_at) with 422 and never calls insert (OI-041)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/properties', { ...PROPERTY_FILLED, id: 'attacker-uuid', created_at: '1999-01-01' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('PUT /api/properties/:id — PropertyForm.tsx edit payload', () => {
  it('clears optional fields to null on edit', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('PUT', '/api/properties/prop_1', PROPERTY_BLANK)
    expect(res.status).toBe(200)
    expectWritten(spy, PROPERTY_BLANK)
  })

  it('does not allow null on a NOT NULL column (name)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('PUT', '/api/properties/prop_1', { name: null })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects unexpected fields with 422 and never calls update', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('PUT', '/api/properties/prop_1', { notes: 'x', id: 'y' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tenants — TenantForm.tsx handleSubmit (POST create, PUT edit)
// ---------------------------------------------------------------------------

const TENANT_FILLED = {
  name: 'Acme Logistics LLC',
  contact_name: 'Jane Smith',
  contact_email: 'jane@acmelogistics.example',
  contact_phone: '614-555-0142',
  notes: 'Net 10 on CAM true-ups',
}

const TENANT_BLANK = {
  name: 'Lamar Advantage',
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  notes: null,
}

describe('POST /api/tenants — TenantForm.tsx payload', () => {
  it('inserts a fully filled form unchanged', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/tenants', TENANT_FILLED)
    expect(res.status).toBe(201)
    expectWritten(spy, TENANT_FILLED)
  })

  it('accepts null contact_name / contact_email / contact_phone / notes', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/tenants', TENANT_BLANK)
    expect(res.status).toBe(201)
    expectWritten(spy, TENANT_BLANK)
  })

  it('still rejects a malformed contact_email', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/tenants', { ...TENANT_FILLED, contact_email: 'not-an-email' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects server-owned columns (auth_user_id, stripe_customer_id) with 422 (OI-041)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/tenants', {
      ...TENANT_FILLED,
      auth_user_id: '22222222-2222-2222-2222-222222222222',
      stripe_customer_id: 'cus_attacker',
    })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('PUT /api/tenants/:id — TenantForm.tsx edit payload', () => {
  it('clears optional contact fields to null on edit', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('PUT', '/api/tenants/ten_1', TENANT_BLANK)
    expect(res.status).toBe(200)
    expectWritten(spy, TENANT_BLANK)
  })

  it('rejects unexpected fields with 422 and never calls update', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('PUT', '/api/tenants/ten_1', { notes: 'x', auth_user_id: 'y' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Payments — PaymentsList.tsx handleSubmit (POST only; manual check/wire/other)
// ---------------------------------------------------------------------------

const LEASE_ID = '33333333-3333-3333-3333-333333333333'

const PAYMENT_FILLED = {
  lease_id: LEASE_ID,
  payment_date: '2026-09-01',
  amount: 3500,
  method: 'check',
  check_number: '10457',
  notes: 'September base rent',
}

const PAYMENT_BLANK = {
  lease_id: LEASE_ID,
  payment_date: '2026-09-01',
  amount: 3500,
  method: 'wire',
  check_number: null,
  notes: null,
}

describe('POST /api/payments — PaymentsList.tsx payload', () => {
  it('inserts check_number intact (previously silently stripped)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/payments', PAYMENT_FILLED)
    expect(res.status).toBe(201)
    expectWritten(spy, PAYMENT_FILLED)
  })

  it('accepts null check_number / notes', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/payments', PAYMENT_BLANK)
    expect(res.status).toBe(201)
    expectWritten(spy, PAYMENT_BLANK)
  })

  it('rejects a client-supplied stripe_payment_intent_id — it would squat payments_stripe_pi_uniq and make the real webhook insert read as a duplicate', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/payments', { ...PAYMENT_FILLED, stripe_payment_intent_id: 'pi_forged' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects method ach_stripe on the manual route (ACH rows are written only by the Stripe webhook/cron)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    // Minimal body with no null fields, so the 422 can only come from `method`.
    const res = await send('POST', '/api/payments', { lease_id: LEASE_ID, payment_date: '2026-09-01', amount: 3500, method: 'ach_stripe' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects unexpected fields (id, created_at, stripe_status) with 422 (OI-041)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/payments', { ...PAYMENT_FILLED, id: 'x', created_at: '1999-01-01', stripe_status: 'succeeded' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Drift guards — schema keys vs form source vs migrations
// ---------------------------------------------------------------------------

const root = join(__dirname, '../..')

function sentKeys(componentPath: string): string[] {
  const src = readFileSync(join(root, componentPath), 'utf-8')
  const block = src.match(/mutation\.mutate\(\{([\s\S]*?)\}\)/)
  expect(block, `mutation.mutate({...}) payload not found in ${componentPath}`).not.toBeNull()
  return [...block![1].matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1]).sort()
}

function tableColumns(table: string): Set<string> {
  const cols = new Set<string>()
  for (const file of ['0001_core_entities.sql', '0002_financial_tables.sql', '0011_appsec_idempotency_and_scale.sql']) {
    const sql = readFileSync(join(root, 'supabase/migrations', file), 'utf-8')
    const create = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`))
    if (create) for (const m of create[1].matchAll(/^\s*([a-z_]+)\s+[A-Z]/gm)) cols.add(m[1])
    for (const m of sql.matchAll(new RegExp(`^ALTER TABLE ${table} ADD COLUMN ([a-z_]+)`, 'gm'))) cols.add(m[1])
  }
  expect(cols.size, `no columns found for table ${table}`).toBeGreaterThan(0)
  return cols
}

describe.each([
  { name: 'Property', schema: PropertyInsertSchema, component: 'src/pages/properties/PropertyForm.tsx', table: 'properties' },
  { name: 'Tenant', schema: TenantInsertSchema, component: 'src/pages/tenants/TenantForm.tsx', table: 'tenants' },
  { name: 'Payment', schema: PaymentInsertSchema, component: 'src/pages/payments/PaymentsList.tsx', table: 'payments' },
])('$name field drift guard', ({ schema, component, table }) => {
  const schemaKeys = Object.keys(schema.shape).sort()

  it(`schema keys equal the keys ${component} sends`, () => {
    expect(sentKeys(component)).toEqual(schemaKeys)
  })

  it(`every schema key is a real column of ${table}`, () => {
    const columns = tableColumns(table)
    for (const key of schemaKeys) expect(columns, `schema key "${key}" has no column`).toContain(key)
  })
})
