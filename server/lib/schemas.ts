// server/lib/schemas.ts
import { z } from 'zod'

// Shared validators
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
const positiveAmount = z.number().positive('Amount must be positive')
const nonNegativeAmount = z.number().min(0, 'Amount cannot be negative')

// Property — PropertyForm.tsx handleSubmit is the sole API write path (POST
// create, PUT edit; scripts/import-from-pipeline.mjs writes the DB directly).
// Keys match that payload exactly; the form sends null for blank optional
// fields. zip is nullable since 0005_relax_property_zip_and_unit_sf.sql.
export const PropertyInsertSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  state: z.string().length(2),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/, 'Invalid zip').nullish(),
  total_sf: z.number().positive().nullish(),
  property_type: z.enum(['commercial', 'industrial', 'retail', 'multifamily', 'office', 'other']),
  entity_llc: z.string().nullish(),
  notes: z.string().nullish(),
}).strict()
export const PropertyUpdateSchema = PropertyInsertSchema.partial()

// Tenant — TenantForm.tsx handleSubmit is the sole API write path (POST/PUT).
// auth_user_id and stripe_customer_id are server-owned (portal-auth.ts,
// stripe.ts) and deliberately excluded; `.strict()` turns them into a 422.
export const TenantInsertSchema = z.object({
  name: z.string().min(1),
  contact_name: z.string().nullish(),
  contact_email: z.string().email().nullish(),
  contact_phone: z.string().nullish(),
  notes: z.string().nullish(),
}).strict()
export const TenantUpdateSchema = TenantInsertSchema.partial()

// Lease
export const LeaseInsertSchema = z.object({
  tenant_id: z.string().uuid(),
  unit_id: z.string().uuid(),
  status: z.enum(['active', 'expired', 'terminated', 'pending']).default('active'),
  start_date: isoDate,
  end_date: isoDate,
  base_rent_monthly: positiveAmount,
  cam_estimate_monthly: nonNegativeAmount.default(0),
  rent_type: z.enum(['nnn', 'gross', 'modified_gross']).default('nnn'),
  security_deposit: nonNegativeAmount.optional(),
  expense_stop_amount: nonNegativeAmount.nullish(),
  ti_allowance: nonNegativeAmount.nullish(),
  notes: z.string().nullish(),
})
export const LeaseUpdateSchema = LeaseInsertSchema.partial()

// Charge
export const ChargeInsertSchema = z.object({
  lease_id: z.string().uuid(),
  charge_date: isoDate,
  due_date: isoDate,
  period_start: isoDate,
  period_end: isoDate,
  type: z.enum([
    'rent', 'cam_estimate', 'cam_true_up', 'late_fee', 'security_deposit',
    'utility_water', 'utility_gas', 'utility_electric', 'utility_other',
    'percentage_rent', 'other',
  ]),
  amount: nonNegativeAmount,
  description: z.string().optional(),
  source: z.enum(['auto', 'manual']).default('manual'),
  // OI-046 gap closure: migration 0011 made this column NOT NULL with no DB
  // default. Optional here so a client-supplied dedupe key (e.g. an admin
  // UI resending an identical retry) passes through unchanged; charges.ts's
  // POST handler defaults it to `manual:${crypto.randomUUID()}` when absent
  // so every insert still satisfies the NOT NULL constraint.
  idempotency_key: z.string().min(1).optional(),
})

// Payment — manual (check/wire/other) entry from PaymentsList.tsx only. ACH
// rows are written by the Stripe webhook (stripe.ts) and autopay cron
// (cron.ts) straight to the DB, never through this schema. A client-supplied
// stripe_payment_intent_id would occupy payments_stripe_pi_uniq (0011) and
// make the real webhook insert look like a duplicate, so neither it nor
// method 'ach_stripe' is accepted here.
export const PaymentInsertSchema = z.object({
  lease_id: z.string().uuid(),
  payment_date: isoDate,
  amount: positiveAmount,
  method: z.enum(['check', 'wire', 'other']),
  check_number: z.string().nullish(),
  notes: z.string().nullish(),
}).strict()

// Stripe payment-intent client-generated idempotency token — one per pay
// attempt, reused verbatim by the client on retry. Echoed into the Stripe
// idempotencyKey (`pi:<tenantId>:<client_request_id>`) so a client retry
// after a network timeout can't mint a second PaymentIntent (OI-035).
export const PaymentIntentClientRequestIdSchema = z.string().uuid('client_request_id must be a valid UUID')

// Expense — ExpensesList.tsx handleSubmit is the sole write path (create only;
// no admin-UI page issues PUT /expenses/:id yet). Keys match the `expenses`
// columns in 0002_financial_tables.sql exactly; the form sends null for blank
// vendor/invoice_ref/description. `.strict()` per OI-041 — the previous
// non-strict schema named a nonexistent `is_cam_recoverable` column and
// silently stripped the real `recoverable`, so every insert failed PGRST204.
export const ExpenseInsertSchema = z.object({
  property_id: z.string().uuid(),
  expense_date: isoDate,
  amount: positiveAmount,
  category: z.enum(['taxes', 'insurance', 'maintenance', 'utilities', 'management', 'capital', 'other']),
  vendor: z.string().nullish(),
  description: z.string().nullish(),
  recoverable: z.boolean().default(false),
  invoice_ref: z.string().nullish(),
}).strict()
export const ExpenseUpdateSchema = ExpenseInsertSchema.partial()

// CAM reconciliation calculate/save (OI-041 slice)
export const CamCalculateSchema = z.object({
  lease_id: z.string().uuid(),
  reconciliation_year: z.number().int().positive(),
  total_property_recoverable_expenses: positiveAmount,
  total_leased_sf: positiveAmount,
})

// ---------------------------------------------------------------------------
// Remaining CRUD mass-assignment schemas (OI-041 remainder — Task 9).
// All `.strict()` — an unexpected field (including `id`/`created_at`) surfaces
// as a visible 422 rather than being silently dropped. Field lists below were
// verified against the actual admin-UI call sites (see task-9-report.md for
// which pages were checked), not guessed from the DB schema.
// ---------------------------------------------------------------------------

// Budget upsert — unique on (property_id, year, category). BudgetsList.tsx
// saves one category at a time via Promise.all (never a real batch array),
// but budgets.ts's route accepts whatever Supabase .upsert() is handed,
// which passes an array straight through with no row-count bound. The route
// wraps this schema in z.union([BudgetUpsertSchema, z.array(...).max(50)]) —
// 50 is comfortably above the 10-category ceiling ALL_CATEGORIES can ever
// produce in one save, so it's a defensive cap, not a UI-observed batch size.
export const BudgetUpsertSchema = z.object({
  property_id: z.string().uuid(),
  year: z.number().int().min(2000).max(2100),
  category: z.enum([
    'rental_income', 'cam_income', 'other_income',
    'taxes', 'insurance', 'maintenance', 'utilities', 'management', 'capital', 'other',
  ]),
  budgeted_amount: nonNegativeAmount,
}).strict()

// Insurance certificate — InsuranceForm.tsx is the sole write path (create
// only; no admin-UI page currently issues PUT /insurance/:id). `status` is a
// real DB column but is never client-set — insurance.ts's GET always
// overwrites it with a computed value from expiration_date, so it's
// deliberately excluded here rather than trusting a client-supplied value.
export const InsuranceInsertSchema = z.object({
  tenant_id: z.string().uuid(),
  policy_type: z.enum(['general_liability', 'property', 'workers_comp', 'umbrella', 'other']),
  carrier: z.string().nullish(),
  policy_number: z.string().nullish(),
  coverage_amount: positiveAmount.nullish(),
  effective_date: isoDate,
  expiration_date: isoDate,
}).strict()
export const InsuranceUpdateSchema = InsuranceInsertSchema.partial()

// Unit — PropertyDetail.tsx's "Add Unit" form is the sole write path (create
// only; no admin-UI page currently issues PUT /units/:id).
export const UnitInsertSchema = z.object({
  property_id: z.string().uuid(),
  suite: z.string().min(1),
  floor: z.string().nullish(),
  sf: z.number().positive(),
  status: z.enum(['occupied', 'vacant', 'notice', 'unavailable']).default('vacant'),
}).strict()
export const UnitUpdateSchema = UnitInsertSchema.partial()

// Renewal update — no admin-UI page currently issues PUT /renewals/:id
// (RenewalsPipeline.tsx is read-only), so field list follows the plan's
// explicit scope rather than an observed call site: status enum + dates +
// notes only. Deliberately excludes `proposed_terms` (unused by any UI),
// and `id`/`created_at`/`lease_id`/`updated_at` (updated_at stays
// server-stamped in the route, same as before this change).
export const RenewalUpdateSchema = z.object({
  status: z.enum(['tracking', 'proposal_sent', 'negotiating', 'executed', 'declined']).optional(),
  expiration_date: isoDate.optional(),
  target_decision_date: isoDate.nullish(),
  notes: z.string().nullish(),
}).strict()

// Lease amendment insert (POST /leases/:id/amendments) — lease_id comes from
// the URL param, never the body. LeaseDetail.tsx's "Add Amendment" form.
export const LeaseAmendmentInsertSchema = z.object({
  effective_date: isoDate,
  description: z.string().min(1),
  document_path: z.string().nullish(),
  changes: z.record(z.string(), z.unknown()).default({}),
}).strict()

// Lease notice insert (POST /leases/:id/notices) — lease_id comes from the
// URL param. LeaseDetail.tsx's NoticesSection form.
export const LeaseNoticeInsertSchema = z.object({
  notice_type: z.enum([
    'late_payment', 'lease_violation', 'eviction', 'renewal_offer',
    'move_out_confirmation', 'cam_reconciliation', 'other',
  ]),
  sent_date: isoDate,
  method: z.enum(['email', 'certified_mail', 'portal', 'hand_delivered']),
  document_path: z.string().nullish(),
  notes: z.string().nullish(),
}).strict()

// Tenant correspondence insert (POST /tenants/:id/correspondence) — tenant_id
// comes from the URL param. TenantDetail.tsx's CorrespondenceSection form.
export const TenantCorrespondenceInsertSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  contact_date: isoDate,
  subject: z.string().min(1),
  summary: z.string().min(1),
  method: z.enum(['email', 'phone', 'letter', 'portal', 'in_person']),
}).strict()

// Pagination (shared by all list endpoints — added here for co-location)
export const PaginationSchema = z.object({
  limit:  z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
