-- Properties
CREATE TABLE properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  total_sf NUMERIC,
  property_type TEXT NOT NULL DEFAULT 'industrial'
    CHECK (property_type IN ('commercial','industrial','retail','multifamily','office','other')),
  entity_llc TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Units
CREATE TABLE units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  suite TEXT NOT NULL,
  floor TEXT,
  sf NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'vacant'
    CHECK (status IN ('occupied','vacant','notice','unavailable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenants
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  auth_user_id UUID REFERENCES auth.users(id),
  stripe_customer_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Leases
CREATE TABLE leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired','terminated','pending')),
  rent_type TEXT NOT NULL DEFAULT 'nnn'
    CHECK (rent_type IN ('nnn','gross','modified_gross')),
  base_rent_monthly NUMERIC NOT NULL,
  cam_estimate_monthly NUMERIC NOT NULL DEFAULT 0,
  security_deposit NUMERIC NOT NULL DEFAULT 0,
  expense_stop_amount NUMERIC,
  ti_allowance NUMERIC,
  ti_reimbursement_schedule JSONB,
  percentage_rent_terms JSONB,
  options JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lease amendments
CREATE TABLE lease_amendments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  effective_date DATE NOT NULL,
  description TEXT NOT NULL,
  changes JSONB NOT NULL DEFAULT '{}',
  document_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lease documents
CREATE TABLE lease_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('lease','amendment','estoppel','notice','other')),
  name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by TEXT
);

-- Lease move events
CREATE TABLE lease_move_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('move_in','move_out','transfer')),
  effective_date DATE NOT NULL,
  from_unit_id UUID REFERENCES units(id),
  to_unit_id UUID REFERENCES units(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
