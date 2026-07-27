// Pure scorer: compares one extraction result against a fixture's ground truth.
// No network, no model calls -- this is unit-testable on its own (see score.test.ts).
import type { ExtractedFields } from '../../server/lib/lease-extract'
import type { LeaseFixture } from './fixtures'

export const NUMERIC_FIELDS = [
  'base_rent_monthly', 'cam_estimate_monthly', 'security_deposit',
  'ti_allowance', 'expense_stop_amount',
] as const
export const EXACT_MATCH_FIELDS = ['start_date', 'end_date', 'rent_type'] as const
// 'notes' is intentionally excluded from strict field scoring -- free text, scored only
// as present/absent (see FieldOutcome.kind 'notes-*').

export type FieldOutcome =
  | { field: string; kind: 'correct' }
  | { field: string; kind: 'wrong'; expected: unknown; got: unknown }
  | { field: string; kind: 'missed'; expected: unknown } // ground truth had it, model omitted it
  | { field: string; kind: 'hallucinated'; got: unknown } // model produced it, ground truth didn't have it
  | { field: string; kind: 'notes-present' }
  | { field: string; kind: 'notes-missing-expected' }

export interface FixtureScore {
  fixtureId: string
  outcomes: FieldOutcome[]
  correct: number
  wrong: number
  missed: number
  hallucinated: number
  /** correct / (correct + wrong + missed) over the strictly-scored fields (excludes notes). */
  accuracy: number
}

function numericMatch(expected: number, got: unknown): boolean {
  if (typeof got !== 'number') return false
  const tolerance = Math.max(1, Math.abs(expected) * 0.01) // ±$1 or ±1%, whichever is larger
  return Math.abs(expected - got) <= tolerance
}

/** Score one model's extraction against one fixture's ground truth. Pure function. */
export function scoreExtraction(fixture: LeaseFixture, extracted: ExtractedFields): FixtureScore {
  const outcomes: FieldOutcome[] = []
  const scoredFields = [...EXACT_MATCH_FIELDS, ...NUMERIC_FIELDS] as const

  for (const field of scoredFields) {
    const expected = fixture.groundTruth[field]
    const got = extracted[field]
    const expectedPresent = expected !== undefined
    const gotPresent = got !== undefined && got !== null

    if (!expectedPresent && !gotPresent) continue // both correctly silent; not scored
    if (!expectedPresent && gotPresent) {
      outcomes.push({ field, kind: 'hallucinated', got })
      continue
    }
    if (expectedPresent && !gotPresent) {
      outcomes.push({ field, kind: 'missed', expected })
      continue
    }
    const isNumeric = (NUMERIC_FIELDS as readonly string[]).includes(field)
    const matches = isNumeric
      ? numericMatch(expected as number, got)
      : expected === got
    outcomes.push(matches ? { field, kind: 'correct' } : { field, kind: 'wrong', expected, got })
  }

  // Notes: presence-only signal, tracked separately from the strict accuracy denominator.
  const notesExpected = fixture.groundTruth.notes !== undefined
  const notesGot = typeof extracted.notes === 'string' && extracted.notes.trim().length > 0
  if (notesExpected) {
    outcomes.push({ field: 'notes', kind: notesGot ? 'notes-present' : 'notes-missing-expected' })
  }

  const correct = outcomes.filter(o => o.kind === 'correct').length
  const wrong = outcomes.filter(o => o.kind === 'wrong').length
  const missed = outcomes.filter(o => o.kind === 'missed').length
  const hallucinated = outcomes.filter(o => o.kind === 'hallucinated').length
  const denom = correct + wrong + missed
  const accuracy = denom === 0 ? 1 : correct / denom

  return { fixtureId: fixture.id, outcomes, correct, wrong, missed, hallucinated, accuracy }
}

export interface ModelSummary {
  model: string
  fixtureScores: FixtureScore[]
  totalCorrect: number
  totalWrong: number
  totalMissed: number
  totalHallucinated: number
  overallAccuracy: number
}

/** Aggregate per-fixture scores into one model's summary. Pure function. */
export function summarizeModel(model: string, fixtureScores: FixtureScore[]): ModelSummary {
  const totalCorrect = fixtureScores.reduce((s, f) => s + f.correct, 0)
  const totalWrong = fixtureScores.reduce((s, f) => s + f.wrong, 0)
  const totalMissed = fixtureScores.reduce((s, f) => s + f.missed, 0)
  const totalHallucinated = fixtureScores.reduce((s, f) => s + f.hallucinated, 0)
  const denom = totalCorrect + totalWrong + totalMissed
  return {
    model,
    fixtureScores,
    totalCorrect,
    totalWrong,
    totalMissed,
    totalHallucinated,
    overallAccuracy: denom === 0 ? 1 : totalCorrect / denom,
  }
}
