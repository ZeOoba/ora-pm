import { billingTerm, ENTITY_TYPES, type LeaseAbstract } from './lease-abstract'
import { buildMonthlyCharges } from './billing'
import { addMonthsIso, type LeaseSchedule, type RecurringChargeType } from './rent-schedule'

export interface BillingProblem {
  /** YYYY-MM */
  period: string
  /** rent-schedule.ts ScheduleExceptionCode */
  code: string
  detail: string
}

/**
 * Phase 7: monthly billing bills the lease's own schedule (cron passes the 0020 rows to the engine), so a
 * step, abatement or charge that ends bills as the lease states and there is nothing to compare against flat
 * billing any more. What approval must still refuse is a schedule the engine cannot bill: in such a month
 * billing posts NOTHING for the lease (schedule gap, overlap, conflicting concessions, a malformed row).
 * Runs the SAME engine billing runs, over every month of the term.
 */
export function scheduleBillingProblems(
  a: LeaseAbstract, lease: { start_date: string; end_date: string; cam_estimate_monthly: number },
): BillingProblem[] {
  const schedule: LeaseSchedule = {
    rent: a.rent_schedule.map((r) => ({ effective_start: r.start, effective_end: r.end, base_rent_monthly: r.base_rent_monthly ?? NaN })),
    recurring: a.recurring_charges.filter((r) => r.amount_monthly !== null && r.amount_monthly > 0).map((r, i) => ({
      id: `abstract-${i}`, type: r.type as RecurringChargeType, description: r.description.trim() || r.type,
      amount_monthly: r.amount_monthly as number, effective_start: r.effective_start, effective_end: r.effective_end,
    })),
    concessions: a.concessions.map((c) => ({ charge_type: c.charge_type, period_start: c.period_start, period_end: c.period_end, kind: c.kind, value: c.kind === 'full_waiver' ? null : c.value, reason: c.reason })),
  }
  const out: BillingProblem[] = []
  const first = lease.start_date.slice(0, 7) + '-01'
  for (let k = 0; k < 1200; k++) {
    const month = addMonthsIso(first, k)
    if (month > lease.end_date) break
    const r = buildMonthlyCharges({
      leaseId: 'x', baseRentMonthly: 0, camEstimateMonthly: lease.cam_estimate_monthly, schedule,
      leaseStartDate: lease.start_date, leaseEndDate: lease.end_date, periodYear: Number(month.slice(0, 4)), periodMonth: Number(month.slice(5, 7)),
    })
    if (r.exception) out.push({ period: month.slice(0, 7), code: r.exception.code, detail: r.exception.detail })
  }
  return out
}

// Lease abstraction Phase 4: turn a REVALIDATED abstract (lease-abstract.ts revalidateAbstract — never the
// raw client body) into the approve_lease_abstract() payload (migration 0033). Pure; no I/O.
//
// Billing note (Phase 7): monthly billing bills the stored schedule, concessions and recurring charges
// (server/routes/cron.ts → billing.ts → rent-schedule.ts); leases.base_rent_monthly is display only once a lease
// has schedule rows, and cam_estimate_monthly bills only when there is no cam_estimate recurring row. The lease
// row carries the rent and CAM in effect at the START of the billing term, and start_date is the RENT
// commencement date when the lease states one (a free-rent stretch before rent commencement must not bill).

export type TenantChoice =
  | { mode: 'new'; name: string; contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null; notes?: string | null }
  | { mode: 'existing'; id: string }

export interface ApproveInputs {
  unitId: string
  today: string
  tenant: TenantChoice
  replace: { lease_id: string; end_date: string } | null
  notes: string | null
  storagePath: string
  fileSha256: string
  filename: string
  model: string
  approvedBy: string
  warnings: string[]
}

/** A reviewer-correctable problem; `reason` is a fixed server-authored sentence safe to show. */
export class ApprovalInputError extends Error {
  constructor(readonly reason: string) { super(reason) }
}

/** The lease's schedule cannot be billed in some month (billing would post nothing for it there). */
export class ScheduleUnbillableError extends ApprovalInputError {
  constructor(readonly months: BillingProblem[]) {
    super(`Monthly billing cannot bill this lease's schedule in ${months.length} month(s), starting ${months[0].period}: ${months[0].detail}. Correct the rent schedule, concessions or charges.`)
  }
}

const blankToNull = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null)

export function buildApprovalPayload(a: LeaseAbstract, inp: ApproveInputs): Record<string, unknown> {
  const term = billingTerm(a)
  if (!term) throw new ApprovalInputError('The lease needs a commencement (or rent commencement) date and an expiration date.')
  const rows = [...a.rent_schedule].sort((x, y) => x.start.localeCompare(y.start))
  if (rows.length === 0) throw new ApprovalInputError('The lease needs a rent schedule.')
  if (rows.some((r) => r.base_rent_monthly === null)) throw new ApprovalInputError('Every rent period needs a resolved monthly amount.')

  const covering = <T extends { effective_start: string; effective_end: string }>(items: T[], d: string) =>
    items.find((x) => x.effective_start <= d && d <= x.effective_end)
  const rent0 = rows.find((r) => r.start <= term.start && term.start <= r.end) ?? rows[0]
  const camRows = a.recurring_charges.filter((r) => r.type === 'cam_estimate' && r.amount_monthly !== null)
  const cam0 = covering(camRows, term.start)

  const party = {
    legal_name: a.tenant_legal_name?.value ?? null,
    dba: a.tenant_dba?.value ?? null,
    entity_type: a.tenant_entity_type && (ENTITY_TYPES as readonly string[]).includes(a.tenant_entity_type.value) ? a.tenant_entity_type.value : null,
    state_of_formation: normalizeState(a.tenant_state_of_formation?.value ?? null),
    notice_address: a.notice_address?.value ?? null,
    guarantor_name: a.guarantor_name?.value ?? null,
  }
  const tenant = inp.tenant.mode === 'new'
    ? {
        mode: 'new',
        name: inp.tenant.name.trim(),
        contact_name: blankToNull(inp.tenant.contact_name),
        contact_email: blankToNull(inp.tenant.contact_email),
        contact_phone: blankToNull(inp.tenant.contact_phone),
        notes: blankToNull(inp.tenant.notes),
        ...party,
      }
    : { mode: 'existing', id: inp.tenant.id, ...party }
  if (tenant.mode === 'new' && !(tenant as { name: string }).name) throw new ApprovalInputError('The new tenant needs a name.')

  const share = a.pro_rata_share?.value ?? null
  const e = a.escalation
  if (e && e.cadence_months <= 0) throw new ApprovalInputError('The escalation needs a cadence of at least one month.')
  if (e && e.kind !== 'cpi' && e.value === null) throw new ApprovalInputError('The escalation value could not be resolved.')

  const critical: Array<{ critical_date: string; kind: string; description: string }> = [
    { critical_date: term.end, kind: 'expiration', description: 'Lease expiration' },
  ]
  for (const r of rows.slice(1)) {
    critical.push({ critical_date: r.start, kind: 'rent_step', description: `Base rent steps to $${r.base_rent_monthly!.toFixed(2)}/mo` })
  }
  for (const c of a.concessions) {
    critical.push({ critical_date: c.period_end, kind: 'concession_end', description: `Concession ends: ${c.reason}` })
  }
  const commencement = a.commencement_date?.value
  if (commencement && commencement < term.start) {
    critical.push({ critical_date: term.start, kind: 'other', description: `Rent commencement (lease commenced ${commencement})` })
  }

  const lease = {
    start_date: term.start,
    end_date: term.end,
    rent_type: a.rent_type?.value ?? 'nnn',
    base_rent_monthly: rent0.base_rent_monthly as number,
    cam_estimate_monthly: cam0?.amount_monthly ?? 0,
    security_deposit: a.security_deposit?.value ?? 0,
    expense_stop_amount: a.expense_stop_psf_annual?.value ?? null,
    proportionate_share_pct: share !== null && share > 0 && share <= 1 ? share : null,
    base_year: a.base_year?.value ?? null,
    notes: blankToNull(inp.notes),
  }

  // Plan §5a item 6: a fixed-dollar waiver over rent AND CAM has no defined split (the engine and the 0034 CHECK
  // refuse it); say how to enter it instead of failing on the generic schedule check.
  if (a.concessions.some((c) => c.charge_type === 'all' && c.kind === 'fixed_amount')) {
    throw new ApprovalInputError('A fixed-dollar concession over rent and CAM together has no defined split; enter it as two concessions, one for rent and one for CAM.')
  }
  const problems = scheduleBillingProblems(a, lease)
  if (problems.length > 0) throw new ScheduleUnbillableError(problems)

  return {
    unit_id: inp.unitId,
    today: inp.today,
    tenant,
    replace: inp.replace,
    lease,
    abstract: {
      storage_path: inp.storagePath,
      file_sha256: inp.fileSha256,
      model: inp.model,
      raw_fields: a,
      warnings: inp.warnings,
      approved_by: inp.approvedBy,
    },
    document: { name: inp.filename },
    rent_schedule: rows.map((r) => ({
      effective_start: r.start, effective_end: r.end, base_rent_monthly: r.base_rent_monthly,
      rent_psf_annual: r.rent_psf_annual, note: r.amount_as_written ? `As written: ${r.amount_as_written} per ${r.amount_period}` : 'Derived from escalation',
    })),
    escalation: e
      ? {
          kind: e.kind, value: e.kind === 'cpi' ? null : e.value, cadence_months: e.cadence_months,
          first_adjustment_date: e.first_adjustment_date, applies_until: term.end,
          cpi_floor: e.kind === 'cpi' ? e.cpi_floor : null, cpi_cap: e.kind === 'cpi' ? e.cpi_cap : null,
          clause_ref: `p. ${e.page}`,
        }
      : null,
    concessions: a.concessions.map((c) => ({
      charge_type: c.charge_type, period_start: c.period_start, period_end: c.period_end, kind: c.kind,
      value: c.kind === 'full_waiver' ? null : c.value, reason: c.reason.trim() || 'Concession', clause_ref: `p. ${c.page}`,
    })),
    recurring_charges: a.recurring_charges.filter((r) => r.amount_monthly !== null && r.amount_monthly > 0).map((r) => ({
      type: r.type, description: r.description.trim() || r.type, amount_monthly: r.amount_monthly,
      effective_start: r.effective_start, effective_end: r.effective_end, clause_ref: `p. ${r.page}`,
    })),
    provisions: a.provisions.filter((p) => p.summary.trim()).map((p) => ({
      category: p.category, summary: p.summary.trim(), verbatim_excerpt: p.quote || null, page_ref: p.page > 0 ? p.page : null,
      notice_deadline: p.notice_deadline,
      // The table requires both window ends or neither.
      exercise_window_start: p.exercise_window_start && p.exercise_window_end ? p.exercise_window_start : null,
      exercise_window_end: p.exercise_window_start && p.exercise_window_end ? p.exercise_window_end : null,
    })),
    critical_dates: critical,
  }
}

/** Two-letter uppercase state code, or null (the tenants CHECK rejects anything else). */
function normalizeState(s: string | null): string | null {
  if (!s) return null
  const t = s.trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(t)) return t
  return STATE_CODES[t] ?? null
}

const STATE_CODES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT',
  DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL',
  INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT',
  NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA',
  'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT',
  VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
}
