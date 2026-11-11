import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'
import { pgTable, type Row } from '../fixtures/pg-table'

// B8 ledger core API. The DB-side rules (balance, immutability, period lock) are tested on real
// Postgres by supabase/tests/gl_core.test.sql; this file tests the HTTP layer: validation before
// the RPC, who may post and lock, error mapping, and the trial balance's fail-closed reads.
const admin = vi.hoisted(() => ({ email: 'bookkeeper@example.test' as string | undefined }))
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    if (admin.email) c.set('adminEmail', admin.email)
    return next()
  }),
}))
const mockFrom = vi.hoisted(() => vi.fn())
const mockRpc = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom, rpc: mockRpc }) }))

const LOCKER = 'owner@example.test'
const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test', CRON_SECRET: 'x', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', GL_PERIOD_LOCK_EMAILS: LOCKER }
const app = createApp()
const E = 'e0000000-0000-4000-8000-000000000001'
const A1 = 'a0000000-0000-4000-8000-000000000001'
const A2 = 'a0000000-0000-4000-8000-000000000002'

const post = (path: string, body: unknown, e: Record<string, unknown> = env) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, e)
const get = (path: string) => app.request(path, {}, env)
const entry = (over: Record<string, unknown> = {}) => ({
  entity_id: E, entry_date: '2026-10-05', memo: 'Oct rent, Ste 3',
  lines: [{ account_id: A1, debit: '20192.50' }, { account_id: A2, credit: '20192.50' }], ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  admin.email = 'bookkeeper@example.test'
  mockRpc.mockResolvedValue({ data: 'new-entry-id', error: null })
})

describe('POST /api/gl/journal', () => {
  it('posts through gl_post_entry with integer-cent lines and the admin as poster', async () => {
    const res = await post('/api/gl/journal', entry())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ data: { id: 'new-entry-id', total_cents: 2019250 } })
    expect(mockRpc).toHaveBeenCalledWith('gl_post_entry', {
      p_entity_id: E, p_entry_date: '2026-10-05', p_memo: 'Oct rent, Ste 3', p_source: 'manual', p_posted_by: 'bookkeeper@example.test',
      p_lines: [
        { account_id: A1, debit_cents: 2019250, credit_cents: 0, memo: null },
        { account_id: A2, debit_cents: 0, credit_cents: 2019250, memo: null },
      ],
    })
  })

  it.each([
    ['unbalanced', entry({ lines: [{ account_id: A1, debit: '100.00' }, { account_id: A2, credit: '99.99' }] })],
    ['one line', entry({ lines: [{ account_id: A1, debit: '1' }] })],
    ['numbers instead of exact strings', entry({ lines: [{ account_id: A1, debit: 0.1 }, { account_id: A2, credit: 0.1 }] })],
    ['three decimals', entry({ lines: [{ account_id: A1, debit: '1.005' }, { account_id: A2, credit: '1.005' }] })],
    ['both sides on a line', entry({ lines: [{ account_id: A1, debit: '1', credit: '1' }, { account_id: A2, credit: '1' }] })],
    ['reversal source posted directly', entry({ source: 'reversal' })],
    ['impossible date', entry({ entry_date: '2026-02-30' })],
    ['blank memo', entry({ memo: '  ' })],
    ['extra field', { ...entry(), posted_by: 'someone-else' }],
  ])('%s → 422 and never reaches the database', async (_n, body) => {
    const res = await post('/api/gl/journal', body)
    expect(res.status).toBe(422)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('maps a ledger-rule rejection from the database to 422 with the rule', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'gl: period 2026-09-01 is locked for entity x; post in an open month' } })
    const res = await post('/api/gl/journal', entry({ entry_date: '2026-09-20' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'period 2026-09-01 is locked for entity x; post in an open month' })
  })

  it('any other database error is a generic 500 (no raw message leaked)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection to 10.1.2.3 refused' } })
    const res = await post('/api/gl/journal', entry())
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('10.1.2.3')
  })

  it('refuses to post without an identified admin', async () => {
    admin.email = undefined
    expect((await post('/api/gl/journal', entry())).status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('POST /api/gl/journal/:id/reverse', () => {
  const ID = '99999999-9999-4999-8999-999999999999'
  it('reverses through gl_reverse_entry', async () => {
    const res = await post(`/api/gl/journal/${ID}/reverse`, { entry_date: '2026-11-02', memo: 'Wrong suite' })
    expect(res.status).toBe(201)
    expect(mockRpc).toHaveBeenCalledWith('gl_reverse_entry', { p_entry_id: ID, p_entry_date: '2026-11-02', p_memo: 'Wrong suite', p_posted_by: 'bookkeeper@example.test' })
  })
  it('404 unknown entry, 409 already reversed, 422 bad id', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P0002', message: 'gl: journal entry x not found' } })
    expect((await post(`/api/gl/journal/${ID}/reverse`, { entry_date: '2026-11-02', memo: 'x' })).status).toBe(404)
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "gl_journal_entries_reverses_entry_id_key"' } })
    expect((await post(`/api/gl/journal/${ID}/reverse`, { entry_date: '2026-11-02', memo: 'x' })).status).toBe(409)
    expect((await post('/api/gl/journal/nope/reverse', { entry_date: '2026-11-02', memo: 'x' })).status).toBe(422)
  })
})

describe('POST /api/gl/periods/lock', () => {
  it('only the GL_PERIOD_LOCK_EMAILS approver can lock', async () => {
    expect((await post('/api/gl/periods/lock', { entity_id: E, period_start: '2026-09-01' })).status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
    admin.email = LOCKER
    const res = await post('/api/gl/periods/lock', { entity_id: E, period_start: '2026-09-01' })
    expect(res.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('gl_lock_period', { p_entity_id: E, p_period_start: '2026-09-01', p_locked_by: LOCKER })
  })
  it('fail-closed: with no allowlist configured nobody can lock', async () => {
    admin.email = LOCKER
    const { GL_PERIOD_LOCK_EMAILS: _unused, ...noList } = env
    expect((await post('/api/gl/periods/lock', { entity_id: E, period_start: '2026-09-01' }, noList)).status).toBe(403)
  })
  it('period_start must be a month start; already-locked is 409', async () => {
    admin.email = LOCKER
    expect((await post('/api/gl/periods/lock', { entity_id: E, period_start: '2026-09-15' })).status).toBe(422)
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'gl: period 2026-09-01 is already locked for entity x' } })
    expect((await post('/api/gl/periods/lock', { entity_id: E, period_start: '2026-09-01' })).status).toBe(409)
  })
})

describe('GET /api/gl/trial-balance', () => {
  function install(lines: Row[], opts: { linesError?: boolean } = {}) {
    const tables: Record<string, ReturnType<typeof pgTable>> = {
      gl_accounts: pgTable([
        { id: A1, entity_id: E, number: '1000', qb_name: 'Operating Cash', account_type: 'asset', is_active: true },
        { id: A2, entity_id: E, number: '4000', qb_name: 'Rental Income', account_type: 'income', is_active: true },
      ]),
      gl_journal_lines: pgTable(lines, opts.linesError ? { error: { message: 'boom' } } : {}),
    }
    mockFrom.mockImplementation((t: string) => tables[t])
    return tables
  }
  const line = (id: string, account_id: string, d: number, c: number): Row =>
    ({ id, entity_id: E, account_id, debit_cents: d, credit_cents: c, 'gl_journal_entries.entry_date': '2026-10-05' })

  it('returns per-account totals in cents that tie out', async () => {
    install([line('l1', A1, 2019250, 0), line('l2', A2, 0, 2019250)])
    const res = await get(`/api/gl/trial-balance?entity_id=${E}&as_of=2026-10-31`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { rows: { number: string; net_cents: number }[]; balanced: boolean; debit_cents: number } }
    expect(body.data.balanced).toBe(true)
    expect(body.data.debit_cents).toBe(2019250)
    expect(body.data.rows.map((r) => [r.number, r.net_cents])).toEqual([['1000', 2019250], ['4000', -2019250]])
  })

  it('fails closed on a read error or an out-of-balance read', async () => {
    install([], { linesError: true })
    expect((await get(`/api/gl/trial-balance?entity_id=${E}`)).status).toBe(500)
    install([line('l1', A1, 100, 0)])
    expect((await get(`/api/gl/trial-balance?entity_id=${E}`)).status).toBe(500)
  })

  it('validates params', async () => {
    expect((await get('/api/gl/trial-balance?entity_id=x')).status).toBe(422)
    expect((await get(`/api/gl/trial-balance?entity_id=${E}&as_of=10/31/2026`)).status).toBe(422)
    // impossible dates stop at the API instead of reaching Postgres as a 500 (REFUTE-2 N5)
    expect((await get(`/api/gl/trial-balance?entity_id=${E}&as_of=2026-02-31`)).status).toBe(422)
    expect((await get(`/api/gl/journal?entity_id=${E}&from=2026-02-30`)).status).toBe(422)
    expect((await get(`/api/gl/journal?entity_id=${E}&to=2026-13-01`)).status).toBe(422)
  })
})

describe('chart of accounts import', () => {
  it('rejects duplicate QB names within one import before writing', async () => {
    const insert = vi.fn()
    mockFrom.mockImplementation(() => ({ insert }))
    const res = await post(`/api/gl/entities/${E}/accounts`, { accounts: [
      { qb_name: 'Operating Cash', account_type: 'asset' }, { qb_name: 'operating cash', account_type: 'asset' },
    ] })
    expect(res.status).toBe(422)
    expect(insert).not.toHaveBeenCalled()
  })
  it('rejects an unknown account type', async () => {
    expect((await post(`/api/gl/entities/${E}/accounts`, { accounts: [{ qb_name: 'X', account_type: 'revenue' }] })).status).toBe(422)
  })
})

describe('POST /api/gl/entities/:id/accounts/qb-iif (QuickBooks chart import)', () => {
  const HDR = '!ACCNT\tNAME\tREFNUM\tTIMESTAMP\tACCNTTYPE\tOBAMOUNT\tDESC\tACCNUM\tSCD\tBANKNUM\tEXTRA\tHIDDEN\tDELCOUNT\tUSEID'
  const r = (name: string, type: string, num: string) => `ACCNT\t${name}\t1\t0\t${type}\t0.00\t\t${num}\t0\t\t\t N\t0\tN`.replace('\t N', '\tN')
  const FILE = [HDR, r('Operating Cash', 'BANK', '1000'), r('Rental Income', 'INC', '4000')].join('\r\n')
  const path = `/api/gl/entities/${E}/accounts/qb-iif`

  function install(existing: Row[], insertResult: { data?: Row[] | null; error?: { code: string; message: string } | null } = {}) {
    const select = vi.fn().mockResolvedValue({ data: insertResult.data ?? [{ id: 'n1' }, { id: 'n2' }], error: insertResult.error ?? null })
    const insert = vi.fn(() => ({ select }))
    const tables: Record<string, ReturnType<typeof pgTable>> = {
      gl_entities: pgTable([{ id: E }]),
      gl_accounts: pgTable(existing, { insert }),
    }
    mockFrom.mockImplementation((t: string) => tables[t])
    return { insert }
  }

  it('dry run by default: returns the plan and writes nothing', async () => {
    const { insert } = install([])
    const res = await post(path, { iif: FILE })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { applied: boolean; new: { qb_name: string; account_type: string; qb_account_type: string }[] } }
    expect(body.data.applied).toBe(false)
    expect(body.data.new.map((a) => [a.qb_name, a.account_type, a.qb_account_type])).toEqual([['Operating Cash', 'asset', 'BANK'], ['Rental Income', 'income', 'INC']])
    expect(insert).not.toHaveBeenCalled()
  })

  it('apply inserts only the new accounts, in one statement, with the QB type', async () => {
    const { insert } = install([{ id: 'a1', entity_id: E, qb_name: 'Operating Cash', number: '1000', account_type: 'asset', qb_account_type: 'BANK', is_active: true }],
      { data: [{ id: 'n2' }] })
    const res = await post(path, { iif: FILE, apply: true })
    expect(res.status).toBe(201)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledWith([{ entity_id: E, qb_name: 'Rental Income', number: '4000', account_type: 'income', qb_account_type: 'INC', is_active: true }])
    expect((await res.json() as { data: { inserted: number } }).data.inserted).toBe(1)
  })

  it('apply refuses the whole file on any conflict (409) and writes nothing', async () => {
    const { insert } = install([{ id: 'a1', entity_id: E, qb_name: 'Operating Cash', number: '1000', account_type: 'liability', qb_account_type: null, is_active: true }])
    const res = await post(path, { iif: FILE, apply: true })
    expect(res.status).toBe(409)
    expect(insert).not.toHaveBeenCalled()
  })

  it('a bad file is a 422 with the reasons; unknown entity 404; bad body 422', async () => {
    install([])
    const bad = await post(path, { iif: [HDR, r('Cash', 'SAVINGS', '1')].join('\n') })
    expect(bad.status).toBe(422)
    expect(JSON.stringify(await bad.json())).toContain('unknown QuickBooks account type')
    mockFrom.mockImplementation((t: string) => (t === 'gl_entities' ? pgTable([]) : pgTable([])))
    expect((await post(path, { iif: FILE })).status).toBe(404)
    install([])
    expect((await post(path, { iif: '' })).status).toBe(422)
    expect((await post(path, { iif: FILE, apply: 'yes' })).status).toBe(422)
    expect((await post(path, { iif: FILE, entity_id: E })).status).toBe(422)
    expect((await post('/api/gl/entities/nope/accounts/qb-iif', { iif: FILE })).status).toBe(422)
  })

  it('REFUTE N5: apply with the preview count refuses if the ledger changed since the preview', async () => {
    const { insert } = install([])
    const res = await post(path, { iif: FILE, apply: true, expected_new: 1 })
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('changed since the preview')
    expect(insert).not.toHaveBeenCalled()
    expect((await post(path, { iif: FILE, apply: true, expected_new: 2 })).status).toBe(201)
    expect((await post(path, { iif: FILE, apply: true, expected_new: -1 })).status).toBe(422)
  })

  it('an oversized request is refused before its body is read', async () => {
    install([])
    const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(20_000_000) }, body: '{}' }, env)
    expect(res.status).toBe(413)
  })

  it('a concurrent insert of the same account is a 409, not a 500', async () => {
    install([], { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "gl_accounts_entity_qb_name_key"' } })
    expect((await post(path, { iif: FILE, apply: true })).status).toBe(409)
  })
})

describe('opening balance (B8 slice 2)', () => {
  const path = `/api/gl/entities/${E}/opening-balance`
  const CHART = [
    { id: A1, entity_id: E, number: '1000', qb_name: 'Operating Cash', account_type: 'asset', is_active: true },
    { id: A2, entity_id: E, number: '3000', qb_name: "Members' Equity", account_type: 'equity', is_active: true },
  ]
  const CSV = "Account,Debit,Credit\r\n1000 · Operating Cash,\"125,000.00\",\r\nMembers' Equity,,\"125,000.00\"\r\nTOTAL,\"125,000.00\",\"125,000.00\"\r\n"
  function install(entries: Row[] = [], startDate: string | null = null) {
    const tables: Record<string, ReturnType<typeof pgTable>> = {
      gl_entities: pgTable([{ id: E, ledger_start_date: startDate, accounting_basis: 'accrual' }]),
      gl_accounts: pgTable(CHART),
      gl_journal_entries: pgTable(entries),
      gl_journal_lines: pgTable([{ entry_id: 'ob1', line_no: 1, account_id: A1, debit_cents: 100, credit_cents: 0 }]),
    }
    mockFrom.mockImplementation((t: string) => tables[t])
  }
  const OB = { id: 'ob1', entity_id: E, source: 'opening_balance', entry_date: '2026-12-31', memo: 'm', posted_by: 'x', posted_at: '2026-11-11T00:00:00Z', reverses_entry_id: null }

  it('preview: the exact lines and totals, dated the day before the start date; nothing posted', async () => {
    install()
    const res = await post(path, { csv: CSV, start_date: '2027-01-01' })
    expect(res.status).toBe(200)
    const d = (await res.json() as { data: { as_of: string; lines: { account_id: string; debit_cents: number; credit_cents: number }[]; debit_cents: number; applied: boolean } }).data
    expect(d.as_of).toBe('2026-12-31')
    expect(d.lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents])).toEqual([[A1, 12500000, 0], [A2, 0, 12500000]])
    expect(d.debit_cents).toBe(12500000)
    expect(d.applied).toBe(false)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  const previewHash = async (csv = CSV) => (await (await post(path, { csv, start_date: '2027-01-01' })).json() as { data: { plan_hash: string } }).data.plan_hash

  it('apply posts through gl_post_opening_balance with the previewed lines and the admin', async () => {
    install()
    mockRpc.mockResolvedValue({ data: 'ob-new', error: null })
    const hash = await previewHash()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    const res = await post(path, { csv: CSV, start_date: '2027-01-01', apply: true, expected_plan_hash: hash })
    expect(res.status).toBe(201)
    expect(mockRpc).toHaveBeenCalledWith('gl_post_opening_balance', {
      p_entity_id: E, p_start_date: '2027-01-01', p_posted_by: 'bookkeeper@example.test',
      p_lines: [{ account_id: A1, debit_cents: 12500000, credit_cents: 0 }, { account_id: A2, debit_cents: 0, credit_cents: 12500000 }],
    })
  })

  it('apply refuses: a live opening balance (409), a changed total (409), plan errors (422); none reach the database', async () => {
    install([OB])
    const hash = await previewHash()
    expect((await post(path, { csv: CSV, start_date: '2027-01-01', apply: true, expected_plan_hash: hash })).status).toBe(409)
    install()
    expect((await post(path, { csv: CSV, start_date: '2027-01-01', apply: true, expected_plan_hash: 'a'.repeat(64) })).status).toBe(409)
    expect((await post(path, { csv: CSV, start_date: '2027-01-01', apply: true })).status).toBe(422)
    const unbalanced = CSV.replace('Members\' Equity,,"125,000.00"', 'Members\' Equity,,"124,999.99"').replace('TOTAL,"125,000.00","125,000.00"', 'TOTAL,"125,000.00","124,999.99"')
    const res = await post(path, { csv: unbalanced, start_date: '2027-01-01', apply: true, expected_plan_hash: hash })
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('difference $0.01')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('a reversed opening balance no longer blocks a new one', async () => {
    install([OB, { id: 'rev1', entity_id: E, source: 'reversal', entry_date: '2026-12-31', memo: 'r', posted_by: 'x', posted_at: '2026-11-11T01:00:00Z', reverses_entry_id: 'ob1' }])
    mockRpc.mockResolvedValue({ data: 'ob2', error: null })
    expect((await post(path, { csv: CSV, start_date: '2027-01-01', apply: true, expected_plan_hash: await previewHash() })).status).toBe(201)
  })

  it('validates start_date, body and size; warns when the start date would change', async () => {
    install([], '2027-02-01')
    expect((await post(path, { csv: CSV, start_date: '2027-01-15' })).status).toBe(422)
    expect((await post(path, { csv: CSV, start_date: '2027-02-30' })).status).toBe(422)
    expect((await post(path, { csv: CSV, start_date: '2027-01-01', extra: 1 })).status).toBe(422)
    expect((await post(path, { csv: '', start_date: '2027-01-01' })).status).toBe(422)
    const res = await post(path, { csv: CSV, start_date: '2027-01-01' })
    expect(JSON.stringify(await res.json())).toContain('changes this LLC\'s ledger start date from 2027-02-01 to 2027-01-01')
    const big = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '20000000' }, body: '{}' }, env)
    expect(big.status).toBe(413)
  })

  it('REFUTE note: the plan hash pins the exact lines, not just the total', async () => {
    install()
    const swapped = "Account,Debit,Credit\r\nMembers' Equity,,\"125,000.00\"\r\n1000 \u00B7 Operating Cash,\"125,000.00\",\r\nTOTAL,\"125,000.00\",\"125,000.00\"\r\n"
    expect(await previewHash(swapped)).not.toBe(await previewHash())
  })

  it('a ledger-rule rejection from the database is a 422 with the rule', async () => {
    install()
    mockRpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'gl: period 2026-12-01 is locked for entity x; post in an open month' } })
    const res = await post(path, { csv: CSV, start_date: '2027-01-01', apply: true, expected_plan_hash: await previewHash() })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toContain('is locked')
  })

  it('GET returns the start date and the live opening balance with its lines', async () => {
    install([OB], '2027-01-01')
    const res = await get(path)
    expect(res.status).toBe(200)
    const d = (await res.json() as { data: { ledger_start_date: string; opening_balance: { id: string; lines: unknown[] } } }).data
    expect(d.ledger_start_date).toBe('2027-01-01')
    expect(d.opening_balance.id).toBe('ob1')
    expect(d.opening_balance.lines).toHaveLength(1)
  })

  it('the ordinary journal endpoint no longer accepts opening_balance entries', async () => {
    expect((await post('/api/gl/journal', entry({ source: 'opening_balance' }))).status).toBe(422)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('AR posting (B8 slice 3)', () => {
  const base = `/api/gl/entities/${E}/ar`
  const P1 = 'f0000000-0000-4000-8000-000000000001'
  const U1 = 'f1000000-0000-4000-8000-000000000001'
  const L1 = 'f2000000-0000-4000-8000-000000000001'
  function install(opts: { basis?: string; start?: string | null; tieout?: boolean; charges?: Row[]; payments?: Row[]; postings?: Row[]; locked?: string[] } = {}) {
    const tables: Record<string, ReturnType<typeof pgTable>> = {
      gl_entities: pgTable([{ id: E, accounting_basis: opts.basis ?? 'accrual', ledger_start_date: opts.start === undefined ? '2026-10-01' : opts.start }]),
      gl_ar_tieouts: pgTable(opts.tieout === false ? [] : [{ entity_id: E }]),
      properties: pgTable([{ id: P1, gl_entity_id: E }]),
      units: pgTable([{ id: U1, property_id: P1 }]),
      leases: pgTable([{ id: L1, unit_id: U1 }]),
      charges: pgTable(opts.charges ?? [{ id: 'c1', lease_id: L1, charge_date: '2026-10-01', type: 'rent', amount: 1000, description: null, voided_at: null }]),
      payments: pgTable(opts.payments ?? [{ id: 'p1', lease_id: L1, payment_date: '2026-10-03', amount: '1000.00', method: 'check', stripe_status: null, status_changed_at: null }]),
      gl_ar_postings: pgTable(opts.postings ?? []),
      gl_ar_tieout_items: pgTable([]),
      gl_periods: pgTable((opts.locked ?? []).map((m) => ({ entity_id: E, period_start: m, status: 'locked' }))),
      gl_ar_accounts: pgTable([{ entity_id: E, role: 'ar', account_id: A1 }, { entity_id: E, role: 'undeposited_funds', account_id: A2 }, { entity_id: E, role: 'rent', account_id: A2 }]),
    }
    mockFrom.mockImplementation((t: string) => tables[t])
  }
  const preview = async (through = '2026-10-31') => (await (await post(`${base}/run`, { through })).json() as { data: { plan_hash: string; items: { kind: string; source_id: string }[] } }).data

  it('preview lists exactly what would post, in order, and writes nothing', async () => {
    install()
    const d = await preview()
    expect(d.items.map((i) => [i.kind, i.source_id])).toEqual([['charge', 'c1'], ['payment', 'p1']])
    expect(d.plan_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('apply posts the previewed items through gl_post_ar_batch (kinds and ids only)', async () => {
    install()
    mockRpc.mockResolvedValue({ data: 2, error: null })
    const { plan_hash } = await preview()
    const res = await post(`${base}/run`, { through: '2026-10-31', apply: true, expected_plan_hash: plan_hash })
    expect(res.status).toBe(201)
    expect(mockRpc).toHaveBeenCalledWith('gl_post_ar_batch', {
      p_entity_id: E, p_through: '2026-10-31', p_posted_by: 'bookkeeper@example.test',
      p_items: [{ kind: 'charge', source_id: 'c1' }, { kind: 'payment', source_id: 'p1' }],
    })
  })

  it('apply refuses a stale preview (409), a missing hash (422), and a concurrent post (409)', async () => {
    install()
    const { plan_hash } = await preview()
    install({ postings: [{ id: 'x', entity_id: E, kind: 'charge', source_id: 'c1' }] })
    expect((await post(`${base}/run`, { through: '2026-10-31', apply: true, expected_plan_hash: plan_hash })).status).toBe(409)
    expect((await post(`${base}/run`, { through: '2026-10-31', apply: true })).status).toBe(422)
    install()
    mockRpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "gl_ar_postings_once"' } })
    expect((await post(`${base}/run`, { through: '2026-10-31', apply: true, expected_plan_hash: (await preview()).plan_hash })).status).toBe(409)
  })

  it('refuses cash-basis LLCs, no tie-out, no start date, and a through date outside start..today', async () => {
    install({ basis: 'cash' })
    expect(JSON.stringify(await (await post(`${base}/run`, { through: '2026-10-31' })).json())).toContain('cash-basis LLCs is not available yet')
    install({ tieout: false })
    expect((await post(`${base}/run`, { through: '2026-10-31' })).status).toBe(409)
    install({ start: null })
    expect((await post(`${base}/run`, { through: '2026-10-31' })).status).toBe(422)
    install()
    expect((await post(`${base}/run`, { through: '2026-09-30' })).status).toBe(422)
    expect((await post(`${base}/run`, { through: '2099-01-01' })).status).toBe(422)
    expect((await post(`${base}/run`, { through: '2026-02-30' })).status).toBe(422)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('locked months: their activity is planned on the first day of the next open month', async () => {
    install({ locked: ['2026-10-01'] })
    expect((await preview('2026-10-31')).items).toEqual([])
    const d = await preview('2026-11-10')
    expect(d.items.map((i) => [i.kind, (i as unknown as { date: string }).date])).toEqual([['charge', '2026-11-01'], ['payment', '2026-11-01']])
  })

  it('an unmapped role blocks the run (422) with the role named', async () => {
    install({ charges: [{ id: 'c9', lease_id: L1, charge_date: '2026-10-02', type: 'late_fee', amount: 50, description: null, voided_at: null }], payments: [] })
    const res = await post(`${base}/run`, { through: '2026-10-31' })
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('map an account to \\"late fee\\"')
  })

  it('tie-out goes through gl_confirm_ar_tieout; a mismatch is a 422 with the numbers', async () => {
    mockRpc.mockResolvedValueOnce({ data: 20000, error: null })
    const ok = await post(`${base}/tieout`, {})
    expect(ok.status).toBe(201)
    expect(mockRpc).toHaveBeenCalledWith('gl_confirm_ar_tieout', { p_entity_id: E, p_confirmed_by: 'bookkeeper@example.test' })
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'gl: AR does not tie: the app shows 20000 cents of open AR as of 2026-09-30, the ledger\'s AR account 19999 cents (difference 1 cents)' } })
    const bad = await post(`${base}/tieout`, {})
    expect(bad.status).toBe(422)
    expect((await bad.json() as { error: string }).error).toContain('difference 1 cents')
  })

  it('account roles: validated before writing', async () => {
    const upsert = vi.fn()
    mockFrom.mockImplementation(() => ({ upsert }))
    expect((await app.request(`${base}/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles: { bogus: A1 } }) }, env)).status).toBe(422)
    expect((await app.request(`${base}/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles: { ar: 'not-a-uuid' } }) }, env)).status).toBe(422)
    expect(upsert).not.toHaveBeenCalled()
  })
})
