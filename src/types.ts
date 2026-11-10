// ── Enums ──────────────────────────────────────────────────────────────────
export type PropertyType = 'commercial' | 'industrial' | 'retail' | 'multifamily' | 'office' | 'other'
export type UnitStatus = 'occupied' | 'vacant' | 'notice' | 'unavailable'
export type LeaseStatus = 'active' | 'expired' | 'terminated' | 'pending'
export type RentType = 'nnn' | 'gross' | 'modified_gross'
export type ChargeType =
  | 'rent' | 'cam_estimate' | 'cam_true_up' | 'late_fee' | 'security_deposit'
  | 'utility_water' | 'utility_gas' | 'utility_electric' | 'utility_other'
  | 'percentage_rent' | 'other'
export type ChargeSource = 'auto' | 'manual'
export type PaymentMethod = 'ach_stripe' | 'check' | 'wire' | 'other'
export type ExpenseCategory = 'taxes' | 'insurance' | 'maintenance' | 'utilities' | 'management' | 'capital' | 'other'
export type CAMStatus = 'draft' | 'billed' | 'collected'
export type InsurancePolicyType = 'general_liability' | 'property' | 'workers_comp' | 'umbrella' | 'other'
export type InsuranceStatus = 'active' | 'expiring_soon' | 'expired' | 'missing'
export type RenewalStatus = 'tracking' | 'proposal_sent' | 'negotiating' | 'executed' | 'declined'
export type NoticeType = 'late_payment' | 'lease_violation' | 'eviction' | 'renewal_offer' | 'move_out_confirmation' | 'cam_reconciliation' | 'other'
export type BudgetCategory = 'rental_income' | 'cam_income' | 'other_income' | 'taxes' | 'insurance' | 'maintenance' | 'utilities' | 'management' | 'capital' | 'other'
export type ExportStatus = 'draft' | 'exported' | 'imported_to_qb'
export type CriticalDateUrgency = 'overdue' | 'urgent' | 'warning' | 'notice'

// ── Table types ────────────────────────────────────────────────────────────
export interface Property {
  id: string; name: string; address: string; city: string; state: string; zip: string
  total_sf: number | null; property_type: PropertyType; entity_llc: string | null
  /** 0021: CAM Proportionate Share denominator (building/project rentable SF the lease names). */
  cam_denominator_rsf: number | null
  notes: string | null; created_at: string
}

export interface Unit {
  id: string; property_id: string; suite: string; floor: string | null
  sf: number; status: UnitStatus; created_at: string
}

export interface Tenant {
  id: string; name: string; contact_name: string | null; contact_email: string | null
  contact_phone: string | null; auth_user_id: string | null; stripe_customer_id: string | null
  notes: string | null; created_at: string
}

export interface PercentageRentTerms {
  breakpoint_type: 'natural' | 'artificial'
  breakpoint_amount: number
  percentage_rate: number
}

export interface LeaseOption {
  type: 'renewal' | 'expansion' | 'termination'
  exercise_deadline: string
  description: string
}

export interface Lease {
  id: string; tenant_id: string; unit_id: string
  start_date: string; end_date: string; status: LeaseStatus; rent_type: RentType
  base_rent_monthly: number; cam_estimate_monthly: number; security_deposit: number
  expense_stop_amount: number | null; ti_allowance: number | null
  /** 0021: stated Proportionate Share, fraction in (0,1]; base year + its recoverable total ($). */
  proportionate_share_pct: number | null; base_year: number | null; base_year_expense_amount: number | null
  /** 0024: categories passed through (null = all recoverable), annual cap + its end date, and the
   *  not-reconciled flag with its reason. Optional: absent on rows read before 0024. */
  recoverable_categories?: string[] | null; base_year_categories?: string[] | null
  cam_annual_cap?: number | null; cam_cap_through?: string | null
  cam_reconciled?: boolean; cam_exclusion_reason?: string | null
  ti_reimbursement_schedule: unknown | null
  percentage_rent_terms: PercentageRentTerms | null
  options: LeaseOption[] | null; notes: string | null; created_at: string
  autopay_enabled: boolean
  autopay_payment_method_id: string | null
}

export interface LeaseAmendment {
  id: string; lease_id: string; effective_date: string; description: string
  changes: Record<string, unknown>; document_path: string | null; created_at: string
}

export interface Charge {
  id: string; lease_id: string; charge_date: string; due_date: string
  period_start: string; period_end: string; type: ChargeType; amount: number
  description: string | null; source: ChargeSource; idempotency_key: string | null
  created_at: string
  // OI-278 / migration 0016: both null = live; both set = voided (audit row, excluded from every
  // money sum incl. ar_ledger). The DB CHECK forbids a half-void.
  voided_at: string | null; void_reason: string | null
}

export interface Payment {
  id: string; lease_id: string; payment_date: string; amount: number
  method: PaymentMethod; stripe_payment_intent_id: string | null
  stripe_status: string | null; check_number: string | null
  notes: string | null; idempotency_key: string; created_at: string
}

export interface Expense {
  id: string; property_id: string; expense_date: string; category: ExpenseCategory
  vendor: string | null; amount: number; description: string | null
  recoverable: boolean; invoice_ref: string | null; created_at: string
}

export interface CAMReconciliation {
  id: string; lease_id: string; reconciliation_year: number
  total_property_recoverable_expenses: number; tenant_pro_rata_share_pct: number
  estimated_cam_paid: number; actual_cam_owed: number; true_up_amount: number
  status: CAMStatus; billed_date: string | null; notes: string | null; created_at: string
  /** 0021: how the draft was derived (null = calculated before 0021). */
  share_basis: 'lease_stated_pct' | 'premises_rsf_over_denominator' | null
  recovery_basis: 'full_pro_rata' | 'above_expense_stop' | 'none_gross' | 'above_base_year' | null
  basis_warnings: string | null
}

export interface InsuranceCertificate {
  id: string; tenant_id: string; policy_type: InsurancePolicyType
  carrier: string | null; policy_number: string | null; coverage_amount: number | null
  effective_date: string; expiration_date: string; document_path: string | null
  status: InsuranceStatus; created_at: string
}

export interface Renewal {
  id: string; lease_id: string; status: RenewalStatus; expiration_date: string
  proposed_terms: Record<string, unknown> | null; target_decision_date: string | null
  notes: string | null; created_at: string; updated_at: string
}

export interface Budget {
  id: string; property_id: string; year: number; category: BudgetCategory
  budgeted_amount: number; notes: string | null; created_at: string
}

// ── View types ─────────────────────────────────────────────────────────────
export interface ARLedgerRow {
  lease_id: string; tenant_id: string; unit_id: string; tenant_name: string
  property_id: string; property_name: string; suite: string
  total_charged: number; total_paid: number; balance: number
}

export interface RentRollRow {
  property_id: string; property_name: string; unit_id: string; suite: string; sf: number
  unit_status: UnitStatus; tenant_id: string | null; tenant_name: string | null
  lease_id: string | null; start_date: string | null; end_date: string | null
  lease_status: LeaseStatus | null; rent_type: RentType | null
  base_rent_monthly: number | null; cam_estimate_monthly: number | null
  total_monthly: number | null; rent_psf_annual: number | null
}

export interface CriticalDateRow {
  date_type: 'lease_expiration' | 'insurance_expiry'
  reference_id: string; tenant_name: string
  property_name: string | null; suite: string | null
  critical_date: string; days_until: number; urgency: CriticalDateUrgency
}

export type NoticeMethod = 'email' | 'certified_mail' | 'portal' | 'hand_delivered'
export type CorrespondenceDirection = 'inbound' | 'outbound'
export type CorrespondenceMethod = 'email' | 'phone' | 'letter' | 'portal' | 'in_person'

export interface TenantNotice {
  id: string; lease_id: string; notice_type: NoticeType; sent_date: string
  method: NoticeMethod; document_path: string | null; notes: string | null; created_at: string
}

export interface CorrespondenceEntry {
  id: string; tenant_id: string; direction: CorrespondenceDirection; contact_date: string
  subject: string; summary: string; method: CorrespondenceMethod
  linked_notice_id: string | null; created_at: string; created_by: string | null
}

export interface BrokerCommission {
  id: string; lease_id: string; broker_name: string; broker_company: string | null
  commission_rate_pct: number | null; commission_amount: number | null
  payment_status: 'pending' | 'paid'; payment_date: string | null; notes: string | null; created_at: string
}

export interface LeaseDocument {
  id: string; lease_id: string; type: 'lease' | 'amendment' | 'estoppel' | 'notice' | 'other'
  name: string; storage_path: string; uploaded_at: string; uploaded_by: string | null
}
