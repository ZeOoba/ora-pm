import { describe, it, expect, vi } from 'vitest'
import { handleStripeEvent, ALLOWED_FROM, IN_FLIGHT_STATUSES, TERMINAL_STATUSES } from '../../server/lib/stripe-events'
import type Stripe from 'stripe'
import type { getDb } from '../../server/db/client'

type DB = ReturnType<typeof getDb>

// Records every UPDATE the handler issues — its patch and its filter chain —
// and resolves each one from a per-call script. The handler now ends every
// UPDATE with .select('id') so it can tell "matched zero rows" (supabase-js
// returns data: [] with no error in that case; WITHOUT .select() it returns
// data: null whether or not anything matched — verified against
// @supabase/supabase-js 2.x) from a real write. The OI-233 fallback (find
// the row by PI metadata.client_request_id when the PI id was never written
// back) hangs off that zero-match signal.
type UpdateCall = { patch: Record<string, unknown>; filters: Array<[method: string, col: string, val: unknown]> }
type UpdateResult = { data: Array<{ id: string }> | null; error: { message: string } | null }

function makeDb(script: UpdateResult[] = [{ data: [{ id: 'p1' }], error: null }]) {
  const calls: UpdateCall[] = []
  const update = vi.fn().mockImplementation((patch: Record<string, unknown>) => {
    const call: UpdateCall = { patch, filters: [] }
    calls.push(call)
    const idx = calls.length - 1
    const builder = {
      eq: vi.fn().mockImplementation((col: string, val: unknown) => { call.filters.push(['eq', col, val]); return builder }),
      is: vi.fn().mockImplementation((col: string, val: unknown) => { call.filters.push(['is', col, val]); return builder }),
      in: vi.fn().mockImplementation((col: string, val: unknown) => { call.filters.push(['in', col, val]); return builder }),
      select: vi.fn().mockImplementation(async () => script[idx] ?? { data: [], error: null }),
    }
    return builder
  })
  const from = vi.fn().mockReturnValue({ update })
  return { db: { from } as unknown as DB, calls, update }
}

const MATCHED: UpdateResult = { data: [{ id: 'p1' }], error: null }
const NO_MATCH: UpdateResult = { data: [], error: null }

describe('handleStripeEvent — payment_intent.succeeded', () => {
  it('updates stripe_status to succeeded by PI id (single UPDATE when the id matches)', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_abc', metadata: {} } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(1)
    expect(calls[0].patch).toEqual({ stripe_status: 'succeeded' })
    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_abc'], ['in', 'stripe_status', ALLOWED_FROM.succeeded]])
  })

  // OI-233: the PI id was never written back (stripe.ts's post-Stripe UPDATE
  // failed), so the direct match finds nothing. The reservation row still
  // exists with the client_request_id the route stamped into the PI's
  // metadata — complete the write-back from the webhook.
  it('OI-233: falls back to the pending row by metadata.client_request_id when no row carries the PI id, and writes the PI id onto it', async () => {
    const { db, calls } = makeDb([NO_MATCH, MATCHED])
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_orphan', metadata: { lease_id: 'l1', tenant_id: 't1', client_request_id: 'crid-1' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(2)
    expect(calls[1].patch).toEqual({ stripe_status: 'succeeded', stripe_payment_intent_id: 'pi_orphan' })
    expect(calls[1].filters).toEqual([
      ['eq', 'client_request_id', 'crid-1'],
      ['is', 'stripe_payment_intent_id', null],
      ['in', 'stripe_status', ALLOWED_FROM.succeeded],
    ])
  })

  it('OI-233: does NOT attempt the fallback when the PI carries no client_request_id (autopay PIs from cron.ts)', async () => {
    const { db, calls } = makeDb([NO_MATCH])
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_autopay', metadata: { lease_id: 'l1', tenant_id: 't1' } } },
    } as unknown as Stripe.Event

    await expect(handleStripeEvent(event, db)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('OI-233: throws (so Stripe retries) when the fallback UPDATE itself errors', async () => {
    const { db } = makeDb([NO_MATCH, { data: null, error: { message: 'connection refused' } }])
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_x', metadata: { client_request_id: 'crid-x' } } },
    } as unknown as Stripe.Event

    await expect(handleStripeEvent(event, db)).rejects.toThrow('DB update failed')
  })
})

describe('handleStripeEvent — payment_intent.processing (OI-233 write-back path)', () => {
  // Stripe emits payment_intent.processing right after an ACH confirm — days
  // before succeeded. It is the earliest point the webhook can complete a
  // write-back that stripe.ts failed to make.
  it('advances a pending row to processing by PI id, only if it is still pending (never regresses a later status)', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'payment_intent.processing',
      data: { object: { id: 'pi_proc', metadata: { client_request_id: 'crid-p' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(1)
    expect(calls[0].patch).toEqual({ stripe_status: 'processing' })
    expect(calls[0].filters).toEqual([
      ['eq', 'stripe_payment_intent_id', 'pi_proc'],
      ['in', 'stripe_status', ['pending']],
    ])
  })

  it('falls back to the client_request_id row (PI id NULL) and writes the PI id + processing onto it', async () => {
    const { db, calls } = makeDb([NO_MATCH, MATCHED])
    const event = {
      type: 'payment_intent.processing',
      data: { object: { id: 'pi_proc2', metadata: { client_request_id: 'crid-p2' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(2)
    expect(calls[1].patch).toEqual({ stripe_status: 'processing', stripe_payment_intent_id: 'pi_proc2' })
    expect(calls[1].filters).toEqual([
      ['eq', 'client_request_id', 'crid-p2'],
      ['is', 'stripe_payment_intent_id', null],
      ['in', 'stripe_status', ['pending']],
    ])
  })
})

describe('handleStripeEvent — payment_intent.payment_failed', () => {
  it('updates stripe_status to failed with error message in notes', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_fail', last_payment_error: { message: 'Insufficient funds' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls[0].patch).toEqual(expect.objectContaining({ stripe_status: 'failed', notes: expect.stringContaining('Insufficient funds') }))
    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_fail'], ['in', 'stripe_status', ALLOWED_FROM.payment_failed]])
  })

  it('OI-233: falls back to the client_request_id row when no row carries the PI id', async () => {
    const { db, calls } = makeDb([NO_MATCH, MATCHED])
    const event = {
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_fail2', metadata: { client_request_id: 'crid-f' }, last_payment_error: { message: 'NSF' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(2)
    expect(calls[1].patch).toEqual(expect.objectContaining({ stripe_status: 'failed', stripe_payment_intent_id: 'pi_fail2' }))
    expect(calls[1].filters).toEqual([
      ['eq', 'client_request_id', 'crid-f'],
      ['is', 'stripe_payment_intent_id', null],
      ['in', 'stripe_status', ALLOWED_FROM.payment_failed],
    ])
  })
})

describe('handleStripeEvent — payment_intent.canceled', () => {
  it('updates stripe_status to failed with canceled note', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_cancel' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls[0].patch).toEqual(expect.objectContaining({ stripe_status: 'failed', notes: expect.stringContaining('canceled') }))
  })

  it('OI-233: falls back to the client_request_id row when no row carries the PI id', async () => {
    const { db, calls } = makeDb([NO_MATCH, MATCHED])
    const event = {
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_cancel2', metadata: { client_request_id: 'crid-c' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(2)
    expect(calls[1].patch).toEqual(expect.objectContaining({ stripe_status: 'failed', stripe_payment_intent_id: 'pi_cancel2' }))
  })
})

describe('handleStripeEvent — charge.failed', () => {
  it('updates stripe_status to returned with ACH return info', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'charge.failed',
      data: {
        object: {
          id: 'ch_fail',
          payment_intent: 'pi_ach',
          failure_code: 'insufficient_funds',
          failure_message: 'Your card has insufficient funds.',
        },
      },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls[0].patch).toEqual(expect.objectContaining({ stripe_status: 'returned', notes: expect.stringContaining('insufficient_funds') }))
    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_ach'], ['in', 'stripe_status', ALLOWED_FROM.returned]])
  })

  it('does nothing if charge has no payment_intent', async () => {
    const { db, update } = makeDb()
    const event = {
      type: 'charge.failed',
      data: { object: { id: 'ch_nopi', payment_intent: null, failure_code: 'lost_card' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(update).not.toHaveBeenCalled()
  })
})

describe('handleStripeEvent — charge.dispute.created', () => {
  it('updates stripe_status to disputed (E9: a distinct status, not failed) with dispute reason', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', payment_intent: 'pi_dis', reason: 'fraudulent' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls[0].patch).toEqual(expect.objectContaining({ stripe_status: 'disputed', notes: expect.stringContaining('fraudulent') }))
    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_dis'], ['in', 'stripe_status', ALLOWED_FROM.disputed]])
  })

  it('does nothing if dispute has no payment_intent', async () => {
    const { db, update } = makeDb()
    const event = {
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_nopi', payment_intent: null, reason: 'general' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(update).not.toHaveBeenCalled()
  })
})

describe('handleStripeEvent — unknown event type', () => {
  it('silently ignores unknown event types', async () => {
    const { db, update } = makeDb()
    const event = {
      type: 'customer.created',
      data: { object: {} },
    } as unknown as Stripe.Event

    await expect(handleStripeEvent(event, db)).resolves.toBeUndefined()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('handleStripeEvent — DB error propagation', () => {
  it('throws when DB update fails so Stripe retries delivery', async () => {
    const { db } = makeDb([{ data: null, error: { message: 'connection refused' } }])
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_dberr', metadata: {} } },
    } as unknown as Stripe.Event

    await expect(handleStripeEvent(event, db)).rejects.toThrow('DB update failed')
  })
})

describe('handleStripeEvent — expanded payment_intent object', () => {
  it('extracts .id when charge.payment_intent is an expanded object', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'charge.failed',
      data: {
        object: {
          id: 'ch_exp',
          payment_intent: { id: 'pi_expanded', object: 'payment_intent' },
          failure_code: 'nsf',
          failure_message: 'Insufficient funds',
        },
      },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_expanded'], ['in', 'stripe_status', ALLOWED_FROM.returned]])
  })
})


// ---------------------------------------------------------------------------
// Audit finding webhook-succeeded-regresses-terminal-status: Stripe does not
// guarantee event order and retries deliveries, and the handler used to apply
// every event unconditionally, so a late payment_intent.succeeded could move a
// returned / failed / canceled row back to 'succeeded' (ar_ledger then credits a
// bounced ACH payment as collected). Every update is now gated by an explicit
// allowed-transition table.
// ---------------------------------------------------------------------------
describe('allowed-transition table', () => {
  it('no event moves a row OUT of a terminal state (failed / returned / canceled)', () => {
    for (const [event, from] of Object.entries(ALLOWED_FROM)) {
      for (const terminal of TERMINAL_STATUSES) {
        expect({ event, allowsFrom: terminal, allowed: from.includes(terminal) }).toEqual({ event, allowsFrom: terminal, allowed: false })
      }
    }
  })

  it('only an ACH return or a dispute may override succeeded', () => {
    const fromSucceeded = Object.entries(ALLOWED_FROM).filter(([, from]) => from.includes('succeeded')).map(([e]) => e).sort()
    expect(fromSucceeded).toEqual(['disputed', 'returned'])
  })

  // E9/E10: 'disputed' is NOT terminal (a closed dispute resolves it) but no PaymentIntent
  // lifecycle event may move a row out of it; only the dispute's own outcome, or an ACH return
  // (money gone either way), can.
  it('a disputed row leaves only via dispute_won / dispute_lost, or an ACH return', () => {
    const fromDisputed = Object.entries(ALLOWED_FROM).filter(([, from]) => from.includes('disputed')).map(([e]) => e).sort()
    expect(fromDisputed).toEqual(['dispute_lost', 'dispute_won', 'returned'])
    expect(ALLOWED_FROM.dispute_won).toEqual(['disputed'])
    expect(ALLOWED_FROM.dispute_lost).toEqual(['disputed'])
    expect(IN_FLIGHT_STATUSES as readonly string[]).not.toContain('disputed')
    expect(TERMINAL_STATUSES as readonly string[]).not.toContain('disputed')
  })

  it('processing only advances a pending row; succeeded/failed/canceled advance any in-flight row', () => {
    expect(ALLOWED_FROM.processing).toEqual(['pending'])
    for (const e of ['succeeded', 'payment_failed', 'canceled'] as const) {
      expect([...ALLOWED_FROM[e]].sort()).toEqual([...IN_FLIGHT_STATUSES].sort())
    }
  })
})

// A real (in-memory) payments table: every UPDATE applies its eq / is / in
// filters to the stored rows and mutates only the matches, so a sequence of
// events behaves the way it would against Postgres.
type PayRow = { id: string; stripe_payment_intent_id: string | null; client_request_id?: string | null; stripe_status: string | null; notes?: string | null }
function statefulDb(rows: PayRow[]) {
  const from = vi.fn().mockImplementation(() => ({
    update: (patch: Record<string, unknown>) => {
      const preds: Array<(r: PayRow) => boolean> = []
      const b = {
        eq: (col: string, val: unknown) => { preds.push((r) => (r as Record<string, unknown>)[col] === val); return b },
        is: (col: string, val: unknown) => { preds.push((r) => ((r as Record<string, unknown>)[col] ?? null) === val); return b },
        in: (col: string, vals: readonly unknown[]) => { preds.push((r) => vals.includes((r as Record<string, unknown>)[col])); return b },
        select: async () => {
          const hit = rows.filter((r) => preds.every((p) => p(r)))
          for (const r of hit) Object.assign(r, patch)
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        },
      }
      return b
    },
  }))
  return { from } as unknown as DB
}

const ev = {
  processing: (pi: string) => ({ type: 'payment_intent.processing', data: { object: { id: pi, metadata: {} } } }),
  succeeded: (pi: string, metadata: Record<string, string> = {}) => ({ type: 'payment_intent.succeeded', data: { object: { id: pi, metadata } } }),
  failed: (pi: string) => ({ type: 'payment_intent.payment_failed', data: { object: { id: pi, metadata: {}, last_payment_error: { message: 'NSF' } } } }),
  canceled: (pi: string) => ({ type: 'payment_intent.canceled', data: { object: { id: pi, metadata: {} } } }),
  chargeFailed: (pi: string) => ({ type: 'charge.failed', data: { object: { id: 'ch_1', payment_intent: pi, failure_code: 'R01', failure_message: 'Insufficient funds' } } }),
  dispute: (pi: string) => ({ type: 'charge.dispute.created', data: { object: { id: 'dp_1', payment_intent: pi, reason: 'fraudulent' } } }),
  disputeClosed: (pi: string, status: string) => ({ type: 'charge.dispute.closed', data: { object: { id: 'dp_1', payment_intent: pi, reason: 'fraudulent', status } } }),
}

async function run(db: DB, ...events: object[]) {
  for (const e of events) await handleStripeEvent(e as unknown as Stripe.Event, db)
}

describe('out-of-order / retried webhook sequences (stateful)', () => {
  const row = (status: string): PayRow => ({ id: 'p1', stripe_payment_intent_id: 'pi_1', client_request_id: null, stripe_status: status, notes: null })

  it('charge.failed (ACH return) then a late payment_intent.succeeded stays returned', async () => {
    const r = row('processing'); const db = statefulDb([r])
    await run(db, ev.chargeFailed('pi_1'), ev.succeeded('pi_1'))
    expect(r.stripe_status).toBe('returned')
  })

  it('payment_failed then a late succeeded stays failed', async () => {
    const r = row('processing'); const db = statefulDb([r])
    await run(db, ev.failed('pi_1'), ev.succeeded('pi_1'))
    expect(r.stripe_status).toBe('failed')
  })

  it('canceled then a late succeeded stays failed (canceled)', async () => {
    const r = row('requires_action'); const db = statefulDb([r])
    await run(db, ev.canceled('pi_1'), ev.succeeded('pi_1'))
    expect(r.stripe_status).toBe('failed')
    expect(r.notes).toMatch(/canceled/i)
  })

  it('succeeded then a stale payment_failed stays succeeded', async () => {
    const r = row('processing'); const db = statefulDb([r])
    await run(db, ev.succeeded('pi_1'), ev.failed('pi_1'))
    expect(r.stripe_status).toBe('succeeded')
  })

  it('succeeded then a late processing stays succeeded', async () => {
    const r = row('pending'); const db = statefulDb([r])
    await run(db, ev.succeeded('pi_1'), ev.processing('pi_1'))
    expect(r.stripe_status).toBe('succeeded')
  })

  it('succeeded then charge.failed: the ACH return overrides succeeded', async () => {
    const r = row('processing'); const db = statefulDb([r])
    await run(db, ev.succeeded('pi_1'), ev.chargeFailed('pi_1'))
    expect(r.stripe_status).toBe('returned')
    expect(r.notes).toMatch(/R01/)
  })

  it('succeeded then a dispute: the dispute overrides succeeded', async () => {
    const r = row('processing'); const db = statefulDb([r])
    await run(db, ev.succeeded('pi_1'), ev.dispute('pi_1'))
    expect(r.stripe_status).toBe('disputed')
    expect(r.notes).toMatch(/Dispute/)
  })

  it('dispute delivered BEFORE succeeded: the late succeeded does not erase the dispute', async () => {
    const r = row('processing'); const db = statefulDb([r])
    await run(db, ev.dispute('pi_1'), ev.succeeded('pi_1'))
    expect(r.stripe_status).toBe('disputed')
    expect(r.notes).toMatch(/Dispute/)
  })

  it('a returned row is not rewritten by a later payment_failed or dispute (terminal, notes kept)', async () => {
    const r = row('processing'); const db = statefulDb([r])
    await run(db, ev.chargeFailed('pi_1'), ev.failed('pi_1'), ev.dispute('pi_1'))
    expect(r.stripe_status).toBe('returned')
    expect(r.notes).toMatch(/ACH return/)
  })

  it('a retried (duplicate) succeeded delivery is idempotent', async () => {
    const r = row('processing'); const db = statefulDb([r])
    await run(db, ev.succeeded('pi_1'), ev.succeeded('pi_1'))
    expect(r.stripe_status).toBe('succeeded')
  })

  it('OI-233 fallback path is gated too: a released (failed) reservation is not revived by a late succeeded', async () => {
    const r: PayRow = { id: 'p1', stripe_payment_intent_id: null, client_request_id: 'crid-9', stripe_status: 'failed', notes: 'Stripe card_error' }
    const db = statefulDb([r])
    await run(db, ev.succeeded('pi_9', { client_request_id: 'crid-9' }))
    expect(r.stripe_status).toBe('failed')
    expect(r.stripe_payment_intent_id).toBeNull()
  })

  it('OI-233 fallback still completes a pending reservation on succeeded', async () => {
    const r: PayRow = { id: 'p1', stripe_payment_intent_id: null, client_request_id: 'crid-8', stripe_status: 'pending' }
    const db = statefulDb([r])
    await run(db, ev.succeeded('pi_8', { client_request_id: 'crid-8' }))
    expect(r.stripe_status).toBe('succeeded')
    expect(r.stripe_payment_intent_id).toBe('pi_8')
  })
})

// E10 (PR #53 REFUTE follow-up): charge.dispute.closed was unhandled, so a dispute the landlord
// WON left the payment uncredited and the tenant showing a balance they had paid. A closed
// dispute now resolves the 'disputed' row: won / warning_closed (an inquiry that never pulled the
// funds) -> succeeded; lost -> failed. Both are compare-and-swaps from 'disputed' only.
describe('charge.dispute.closed (stateful)', () => {
  const row = (status: string): PayRow => ({ id: 'p1', stripe_payment_intent_id: 'pi_1', client_request_id: null, stripe_status: status, notes: null })

  it('won: disputed -> succeeded (the payment counts again)', async () => {
    const r = row('processing'); const db = statefulDb([r])
    await run(db, ev.succeeded('pi_1'), ev.dispute('pi_1'), ev.disputeClosed('pi_1', 'won'))
    expect(r.stripe_status).toBe('succeeded')
    expect(r.notes).toMatch(/won/i)
  })

  it('warning_closed (inquiry closed, funds never withdrawn): disputed -> succeeded', async () => {
    const r = row('succeeded'); const db = statefulDb([r])
    await run(db, ev.dispute('pi_1'), ev.disputeClosed('pi_1', 'warning_closed'))
    expect(r.stripe_status).toBe('succeeded')
  })

  it('lost: disputed -> failed (terminal)', async () => {
    const r = row('succeeded'); const db = statefulDb([r])
    await run(db, ev.dispute('pi_1'), ev.disputeClosed('pi_1', 'lost'))
    expect(r.stripe_status).toBe('failed')
    expect(r.notes).toMatch(/lost/i)
  })

  it('lost is terminal: a later (bogus or reordered) won does not revive it', async () => {
    const r = row('succeeded'); const db = statefulDb([r])
    await run(db, ev.dispute('pi_1'), ev.disputeClosed('pi_1', 'lost'), ev.disputeClosed('pi_1', 'won'))
    expect(r.stripe_status).toBe('failed')
  })

  it('a replayed won is idempotent, and PI lifecycle replays do not move the resolved row', async () => {
    const r = row('succeeded'); const db = statefulDb([r])
    await run(db, ev.dispute('pi_1'), ev.disputeClosed('pi_1', 'won'), ev.disputeClosed('pi_1', 'won'), ev.succeeded('pi_1'), ev.failed('pi_1'))
    expect(r.stripe_status).toBe('succeeded')
  })

  it('a closed dispute never touches a row that was not disputed (failed / returned / in-flight / succeeded)', async () => {
    for (const status of ['failed', 'returned', 'canceled', 'processing', 'pending', 'succeeded']) {
      const r = row(status); const db = statefulDb([r])
      await run(db, ev.disputeClosed('pi_1', 'won'), ev.disputeClosed('pi_1', 'lost'))
      expect({ status, now: r.stripe_status }).toEqual({ status, now: status })
    }
  })

  it('an ACH return while disputed is terminal: a later won does not credit it', async () => {
    const r = row('succeeded'); const db = statefulDb([r])
    await run(db, ev.dispute('pi_1'), ev.chargeFailed('pi_1'), ev.disputeClosed('pi_1', 'won'))
    expect(r.stripe_status).toBe('returned')
  })

  it('PaymentIntent lifecycle events do not move a disputed row', async () => {
    const r = row('succeeded'); const db = statefulDb([r])
    await run(db, ev.dispute('pi_1'), ev.succeeded('pi_1'), ev.processing('pi_1'), ev.failed('pi_1'), ev.canceled('pi_1'))
    expect(r.stripe_status).toBe('disputed')
  })

  it('an unrecognized closed status changes nothing and warns (no throw, so Stripe does not retry forever)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = row('succeeded'); const db = statefulDb([r])
    await run(db, ev.dispute('pi_1'), ev.disputeClosed('pi_1', 'under_review'))
    expect(r.stripe_status).toBe('disputed')
    expect(warn.mock.calls.flat().join(' ')).toMatch(/under_review/)
    warn.mockRestore()
  })

  it('a closed dispute with no payment_intent does nothing', async () => {
    const { db, update } = makeDb()
    await handleStripeEvent({ type: 'charge.dispute.closed', data: { object: { id: 'dp_x', payment_intent: null, status: 'won' } } } as unknown as Stripe.Event, db)
    expect(update).not.toHaveBeenCalled()
  })

  it('issues one guarded UPDATE: by PI id, allowed only from disputed', async () => {
    const { db, calls } = makeDb([MATCHED])
    await handleStripeEvent(ev.disputeClosed('pi_w', 'won') as unknown as Stripe.Event, db)
    expect(calls).toHaveLength(1)
    expect(calls[0].patch).toEqual(expect.objectContaining({ stripe_status: 'succeeded' }))
    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_w'], ['in', 'stripe_status', ['disputed']]])
  })

  it('a DB error on the closed-dispute UPDATE throws so Stripe retries', async () => {
    const { db } = makeDb([{ data: null, error: { message: 'connection refused' } }])
    await expect(handleStripeEvent(ev.disputeClosed('pi_e', 'lost') as unknown as Stripe.Event, db)).rejects.toThrow('DB update failed')
  })
})
