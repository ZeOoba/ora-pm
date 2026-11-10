import { daysBetween } from '../today/today-queue'
import type { LeaseOption } from '../../types'

export interface TermGeometry {
  /** Elapsed share of the term, 0–100 (clamped). */
  elapsedPct: number
  /** Today's marker position, 0–100 (clamped). */
  todayPct: number
  monthsRemaining: number
  /** Option deadlines placed on the bar, 0–100 (clamped), earliest first. */
  deadlines: { pct: number; date: string; label: string; passed: boolean }[]
}

export function termGeometry(start: string, end: string, today: string, options: LeaseOption[] | null): TermGeometry {
  const total = Math.max(1, daysBetween(start, end))
  const clamp = (v: number) => Math.min(100, Math.max(0, v))
  const at = (d: string) => clamp((daysBetween(start, d) / total) * 100)
  return {
    elapsedPct: at(today),
    todayPct: at(today),
    monthsRemaining: Math.max(0, Math.round(daysBetween(today, end) / 30.44)),
    deadlines: (options ?? [])
      .filter((o) => !!o.exercise_deadline)
      .map((o) => ({ pct: at(o.exercise_deadline), date: o.exercise_deadline, label: `${o.type} notice`, passed: o.exercise_deadline < today }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }
}
