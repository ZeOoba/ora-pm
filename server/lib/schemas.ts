// server/lib/schemas.ts
import { z } from 'zod'

// Shared validators
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
const positiveAmount = z.number().positive('Amount must be positive')
const nonNegativeAmount = z.number().min(0, 'Amount cannot be negative')

// Property
export const PropertyInsertSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  state: z.string().length(2),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/, 'Invalid zip').optional(),
  total_sf: z.number().positive().optional(),
  property_type: z.enum(['commercial', 'industrial', 'retail', 'multifamily', 'office', 'other']),
  entity_llc: z.string().optional(),
  notes: z.string().optional(),
})
export const PropertyUpdateSchema = PropertyInsertSchema.partial()

// Tenant
export const TenantInsertSchema = z.object({
  name: z.string().min(1),
  contact_name: z.string().optional(),
  contact_email: z.string().email().optional(),
  contact_phone: z.string().optional(),
  notes: z.string().optional(),
})
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
  notes: z.string().optional(),
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
})

// Payment
export const PaymentInsertSchema = z.object({
  lease_id: z.string().uuid(),
  payment_date: isoDate,
  amount: positiveAmount,
  method: z.enum(['ach_stripe', 'check', 'wire', 'other']),
  stripe_payment_intent_id: z.string().optional(),
  notes: z.string().optional(),
})

// Expense
export const ExpenseInsertSchema = z.object({
  property_id: z.string().uuid(),
  expense_date: isoDate,
  amount: positiveAmount,
  category: z.enum(['taxes', 'insurance', 'maintenance', 'utilities', 'management', 'capital', 'other']),
  vendor: z.string().optional(),
  description: z.string().optional(),
  is_cam_recoverable: z.boolean().default(false),
})

// Pagination (shared by all list endpoints — added here for co-location)
export const PaginationSchema = z.object({
  limit:  z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
