-- Charges
CREATE TABLE charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id),
  charge_date DATE NOT NULL,
  due_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'rent','cam_estimate','cam_true_up','late_fee','security_deposit',
    'utility_water','utility_gas','utility_electric','utility_other',
    'percentage_rent','other'
  )),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  description TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('auto','manual')),
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT charge_period_valid CHECK (period_end >= period_start)
);
CREATE INDEX charges_lease_id_idx ON charges(lease_id);
CREATE INDEX charges_period_start_idx ON charges(period_start);
CREATE INDEX charges_type_idx ON charges(type);

-- Payments
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id),
  payment_date DATE NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('ach_stripe','check','wire','other')),
  stripe_payment_intent_id TEXT,
  stripe_status TEXT,
  check_number TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX payments_lease_id_idx ON payments(lease_id);
CREATE INDEX payments_payment_date_idx ON payments(payment_date);
CREATE INDEX payments_stripe_pi_idx ON payments(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- Expenses
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  expense_date DATE NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'taxes','insurance','maintenance','utilities','management','capital','other'
  )),
  vendor TEXT,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  description TEXT,
  recoverable BOOLEAN NOT NULL DEFAULT false,
  invoice_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX expenses_property_id_idx ON expenses(property_id);
CREATE INDEX expenses_expense_date_idx ON expenses(expense_date);
CREATE INDEX expenses_recoverable_idx ON expenses(property_id, recoverable);

-- CAM reconciliations
CREATE TABLE cam_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id),
  reconciliation_year INTEGER NOT NULL,
  total_property_recoverable_expenses NUMERIC NOT NULL DEFAULT 0 CHECK (total_property_recoverable_expenses >= 0),
  tenant_pro_rata_share_pct NUMERIC NOT NULL CHECK (tenant_pro_rata_share_pct >= 0 AND tenant_pro_rata_share_pct <= 1),
  estimated_cam_paid NUMERIC NOT NULL DEFAULT 0,
  actual_cam_owed NUMERIC NOT NULL DEFAULT 0,
  true_up_amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','billed','collected')),
  billed_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(lease_id, reconciliation_year)
);
CREATE INDEX cam_reconciliations_lease_id_idx ON cam_reconciliations(lease_id);
CREATE INDEX cam_reconciliations_year_idx ON cam_reconciliations(reconciliation_year);

-- Tenant sales reports
CREATE TABLE tenant_sales_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  reported_sales NUMERIC NOT NULL DEFAULT 0 CHECK (reported_sales >= 0),
  submitted_date DATE NOT NULL,
  percentage_rent_owed NUMERIC NOT NULL DEFAULT 0 CHECK (percentage_rent_owed >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','verified')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sales_period_valid CHECK (period_end >= period_start)
);
CREATE INDEX tenant_sales_reports_lease_id_idx ON tenant_sales_reports(lease_id);

-- Budgets
CREATE TABLE budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  year INTEGER NOT NULL CHECK (year >= 2000 AND year <= 2100),
  category TEXT NOT NULL CHECK (category IN (
    'rental_income','cam_income','other_income',
    'taxes','insurance','maintenance','utilities','management','capital','other'
  )),
  budgeted_amount NUMERIC NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(property_id, year, category)
);
CREATE INDEX budgets_property_id_year_idx ON budgets(property_id, year);

-- Journal entry exports
CREATE TABLE journal_entry_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by TEXT,
  file_path TEXT,
  line_items JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','exported','imported_to_qb')),
  CONSTRAINT export_period_valid CHECK (period_end >= period_start)
);
CREATE INDEX journal_entry_exports_property_id_idx ON journal_entry_exports(property_id);
