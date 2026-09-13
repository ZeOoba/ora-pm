// tests/routes/expenses-schema-drift.test.ts
//
// 2026-09-12: ExpenseInsertSchema (added in 958770c, 2026-06-05) declared
// `is_cam_recoverable` — a column that never existed. The real column is
// `recoverable` (supabase/migrations/0002_financial_tables.sql). Because the
// schema was not .strict(), the admin form's `recoverable` and `invoice_ref`
// were silently stripped and `is_cam_recoverable: false` was injected, so
// every POST /api/expenses hit PostgREST PGRST204 ("Could not find the
// 'is_cam_recoverable' column") and returned 400. Blank vendor/description
// (sent as null by ExpensesList.tsx) failed earlier with 422, and PUT could
// never change `recoverable`. Net effect: no expense could be created or
// marked recoverable through the app, so CAM recoverable totals were $0.
//
// VALID_* bodies below are the exact shape ExpensesList.tsx handleSubmit
// sends. The drift guard at the bottom re-derives that key set from the
// component source and the migration, so a future rename on either side
// fails here instead of in production.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '../../server/index'
import { ExpenseInsertSchema } from '../../server/lib/schemas'

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

const PROPERTY_ID = '11111111-1111-1111-1111-111111111111'

const VALID_FILLED = {
  property_id: PROPERTY_ID,
  expense_date: '2026-03-15',
  category: 'maintenance',
  vendor: 'Acme Roofing',
  amount: 4250,
  recoverable: true,
  invoice_ref: 'INV-1042',
  description: 'Roof patch, bay 3',
}

const VALID_BLANK = {
  property_id: PROPERTY_ID,
  expense_date: '2026-03-15',
  category: 'taxes',
  vendor: null,
  amount: 18000,
  recoverable: false,
  invoice_ref: null,
  description: null,
}

function tableMock(spy: (row: unknown) => void) {
  const chain = {
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: { id: 'exp_1' }, error: null }),
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

describe('POST /api/expenses — ExpensesList.tsx payload', () => {
  it('inserts a filled form with `recoverable` and `invoice_ref` intact and no phantom column', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/expenses', VALID_FILLED)
    expect(res.status).toBe(201)
    expect(spy).toHaveBeenCalledWith(VALID_FILLED)
    expect(spy.mock.calls[0][0]).not.toHaveProperty('is_cam_recoverable')
  })

  it('accepts null vendor / invoice_ref / description (blank optional fields)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/expenses', VALID_BLANK)
    expect(res.status).toBe(201)
    expect(spy).toHaveBeenCalledWith(VALID_BLANK)
  })

  it('defaults `recoverable` to false when omitted (matches the DB default)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const { recoverable: _omit, ...body } = VALID_FILLED
    const res = await send('POST', '/api/expenses', body)
    expect(res.status).toBe(201)
    expect(spy.mock.calls[0][0]).toMatchObject({ recoverable: false })
  })

  it('rejects unexpected fields (id, created_at) with 422 and never calls insert (OI-041)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/expenses', { ...VALID_FILLED, id: 'attacker-uuid', created_at: '1999-01-01' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects the retired `is_cam_recoverable` key with 422 rather than silently dropping it', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('POST', '/api/expenses', { ...VALID_FILLED, is_cam_recoverable: true })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('PUT /api/expenses/:id', () => {
  it('updates `recoverable` (previously stripped to an empty update)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('PUT', '/api/expenses/exp_1', { recoverable: true })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledWith({ recoverable: true })
  })

  it('does not inject a default `recoverable: false` into an unrelated partial update', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('PUT', '/api/expenses/exp_1', { vendor: 'New Vendor LLC' })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledWith({ vendor: 'New Vendor LLC' })
  })

  it('rejects unexpected fields with 422 and never calls update', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await send('PUT', '/api/expenses/exp_1', { recoverable: true, property_id_override: 'x', id: 'y' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('Expense field drift guard — schema vs ExpensesList.tsx vs migration', () => {
  const schemaKeys = Object.keys(ExpenseInsertSchema.shape).sort()

  it('schema keys equal the keys ExpensesList.tsx handleSubmit sends', () => {
    const src = readFileSync(join(__dirname, '../../src/pages/expenses/ExpensesList.tsx'), 'utf-8')
    const block = src.match(/mutation\.mutate\(\{([\s\S]*?)\}\)/)
    expect(block, 'mutation.mutate({...}) payload not found in ExpensesList.tsx').not.toBeNull()
    const sentKeys = [...block![1].matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1]).sort()
    expect(sentKeys).toEqual(schemaKeys)
  })

  it('every schema key is a real column of the expenses table', () => {
    const sql = readFileSync(join(__dirname, '../../supabase/migrations/0002_financial_tables.sql'), 'utf-8')
    const table = sql.match(/CREATE TABLE expenses \(([\s\S]*?)\n\);/)
    expect(table, 'CREATE TABLE expenses not found').not.toBeNull()
    const columns = new Set([...table![1].matchAll(/^\s*([a-z_]+)\s+[A-Z]/gm)].map(m => m[1]))
    for (const key of schemaKeys) expect(columns, `schema key "${key}" has no column`).toContain(key)
  })
})
