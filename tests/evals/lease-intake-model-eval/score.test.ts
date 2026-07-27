import { describe, it, expect } from 'vitest'
import { scoreExtraction, summarizeModel } from '../../../evals/lease-intake-model-eval/score'
import type { LeaseFixture } from '../../../evals/lease-intake-model-eval/fixtures'

const fixture: LeaseFixture = {
  id: 'fx',
  probes: 'test fixture',
  lines: ['irrelevant for scoring'],
  groundTruth: {
    start_date: '2026-01-01',
    end_date: '2030-12-31',
    rent_type: 'nnn',
    base_rent_monthly: 5000,
    security_deposit: 5000,
    notes: 'has a renewal option',
  },
}

describe('scoreExtraction', () => {
  it('scores every field correct when the extraction matches exactly', () => {
    const s = scoreExtraction(fixture, {
      start_date: '2026-01-01', end_date: '2030-12-31', rent_type: 'nnn',
      base_rent_monthly: 5000, security_deposit: 5000, notes: 'renews for 5 years',
    })
    expect(s.correct).toBe(5)
    expect(s.wrong).toBe(0)
    expect(s.missed).toBe(0)
    expect(s.hallucinated).toBe(0)
    expect(s.accuracy).toBe(1)
    expect(s.outcomes.find(o => o.field === 'notes')).toEqual({ field: 'notes', kind: 'notes-present' })
  })

  it('treats a numeric field within ±1%% or ±$1 (whichever larger) as correct', () => {
    const s = scoreExtraction(fixture, {
      start_date: '2026-01-01', end_date: '2030-12-31', rent_type: 'nnn',
      base_rent_monthly: 5010, // within 1% of 5000
      security_deposit: 5000,
    })
    const rentOutcome = s.outcomes.find(o => o.field === 'base_rent_monthly')
    expect(rentOutcome?.kind).toBe('correct')
  })

  it('flags a numeric field outside tolerance as wrong, not missed', () => {
    const s = scoreExtraction(fixture, {
      start_date: '2026-01-01', end_date: '2030-12-31', rent_type: 'nnn',
      base_rent_monthly: 6000, security_deposit: 5000,
    })
    expect(s.outcomes).toContainEqual({ field: 'base_rent_monthly', kind: 'wrong', expected: 5000, got: 6000 })
    expect(s.wrong).toBe(1)
  })

  it('flags an expected field the model omitted as missed, not wrong', () => {
    const s = scoreExtraction(fixture, {
      start_date: '2026-01-01', end_date: '2030-12-31', rent_type: 'nnn',
      base_rent_monthly: 5000,
      // security_deposit omitted
    })
    expect(s.outcomes).toContainEqual({ field: 'security_deposit', kind: 'missed', expected: 5000 })
    expect(s.missed).toBe(1)
  })

  it('flags a field the model produced that ground truth never had as hallucinated', () => {
    const noTiFixture: LeaseFixture = { ...fixture, groundTruth: { ...fixture.groundTruth, ti_allowance: undefined } }
    const s = scoreExtraction(noTiFixture, {
      start_date: '2026-01-01', end_date: '2030-12-31', rent_type: 'nnn',
      base_rent_monthly: 5000, security_deposit: 5000,
      ti_allowance: 30000, // hallucinated -- never in the ground truth
    })
    expect(s.outcomes).toContainEqual({ field: 'ti_allowance', kind: 'hallucinated', got: 30000 })
    expect(s.hallucinated).toBe(1)
    // A hallucination must not inflate or deflate the strict accuracy denominator.
    expect(s.correct + s.wrong + s.missed).toBe(5)
  })

  it('does not score a field both sides correctly omit', () => {
    const sparse: LeaseFixture = {
      id: 'sparse', probes: 'x', lines: [],
      groundTruth: { start_date: '2026-01-01' },
    }
    const s = scoreExtraction(sparse, { start_date: '2026-01-01' })
    expect(s.correct).toBe(1)
    expect(s.wrong + s.missed + s.hallucinated).toBe(0)
  })

  it('flags missing notes only when ground truth expected them', () => {
    const s = scoreExtraction(fixture, {
      start_date: '2026-01-01', end_date: '2030-12-31', rent_type: 'nnn',
      base_rent_monthly: 5000, security_deposit: 5000,
      // notes omitted, but fixture.groundTruth.notes is set
    })
    expect(s.outcomes).toContainEqual({ field: 'notes', kind: 'notes-missing-expected' })
  })

  it('accuracy is 1 (not NaN) when a fixture has zero strictly-scored fields', () => {
    const empty: LeaseFixture = { id: 'empty', probes: 'x', lines: [], groundTruth: {} }
    const s = scoreExtraction(empty, {})
    expect(s.accuracy).toBe(1)
  })
})

describe('summarizeModel', () => {
  it('aggregates correct/wrong/missed/hallucinated across fixtures', () => {
    const s1 = scoreExtraction(fixture, {
      start_date: '2026-01-01', end_date: '2030-12-31', rent_type: 'nnn',
      base_rent_monthly: 5000, security_deposit: 5000, notes: 'x',
    })
    const s2 = scoreExtraction(fixture, {
      start_date: '2026-01-01', end_date: '2030-12-31', rent_type: 'gross', // wrong
      base_rent_monthly: 5000,
      // security_deposit missed
    })
    const summary = summarizeModel('claude-sonnet-5', [s1, s2])
    expect(summary.totalCorrect).toBe(s1.correct + s2.correct)
    expect(summary.totalWrong).toBe(1)
    expect(summary.totalMissed).toBe(1)
    expect(summary.overallAccuracy).toBeCloseTo(
      (s1.correct + s2.correct) / (s1.correct + s2.correct + 1 + 1),
    )
  })

  it('overallAccuracy is 1 when there is nothing to score at all', () => {
    const summary = summarizeModel('claude-sonnet-5', [])
    expect(summary.overallAccuracy).toBe(1)
  })
})
