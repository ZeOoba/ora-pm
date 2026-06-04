-- Insurance certificates
CREATE TABLE insurance_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  policy_type TEXT NOT NULL CHECK (policy_type IN (
    'general_liability','property','workers_comp','umbrella','other'
  )),
  carrier TEXT,
  policy_number TEXT,
  coverage_amount NUMERIC CHECK (coverage_amount > 0),
  effective_date DATE NOT NULL,
  expiration_date DATE NOT NULL,
  document_path TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expiring_soon','expired','missing')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT insurance_dates_valid CHECK (expiration_date > effective_date)
);
CREATE INDEX insurance_certificates_tenant_id_idx ON insurance_certificates(tenant_id);
CREATE INDEX insurance_certificates_expiration_idx ON insurance_certificates(expiration_date);

-- Tenant notices
CREATE TABLE tenant_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id),
  notice_type TEXT NOT NULL CHECK (notice_type IN (
    'late_payment','lease_violation','eviction','renewal_offer',
    'move_out_confirmation','cam_reconciliation','other'
  )),
  sent_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('email','certified_mail','portal','hand_delivered')),
  document_path TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tenant_notices_lease_id_idx ON tenant_notices(lease_id);

-- Correspondence log
CREATE TABLE correspondence_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  contact_date DATE NOT NULL,
  subject TEXT NOT NULL,
  summary TEXT,
  method TEXT NOT NULL CHECK (method IN ('email','phone','letter','portal','in_person')),
  linked_notice_id UUID REFERENCES tenant_notices(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT
);
CREATE INDEX correspondence_log_tenant_id_idx ON correspondence_log(tenant_id);

-- Renewals
CREATE TABLE renewals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id) UNIQUE,
  status TEXT NOT NULL DEFAULT 'tracking' CHECK (status IN (
    'tracking','proposal_sent','negotiating','executed','declined'
  )),
  expiration_date DATE NOT NULL,
  proposed_terms JSONB,
  target_decision_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX renewals_expiration_date_idx ON renewals(expiration_date);
CREATE INDEX renewals_status_idx ON renewals(status);

-- Broker commissions
CREATE TABLE broker_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES leases(id),
  broker_name TEXT NOT NULL,
  broker_company TEXT,
  commission_rate_pct NUMERIC CHECK (commission_rate_pct >= 0 AND commission_rate_pct <= 100),
  commission_amount NUMERIC NOT NULL CHECK (commission_amount >= 0),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid')),
  payment_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX broker_commissions_lease_id_idx ON broker_commissions(lease_id);

-- Utility meters
CREATE TABLE utility_meters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id UUID NOT NULL REFERENCES units(id),
  utility_type TEXT NOT NULL CHECK (utility_type IN ('water','gas','electric','other')),
  meter_number TEXT,
  reading_unit TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX utility_meters_unit_id_idx ON utility_meters(unit_id);

-- Utility readings
CREATE TABLE utility_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_id UUID NOT NULL REFERENCES utility_meters(id),
  reading_date DATE NOT NULL,
  reading_value NUMERIC NOT NULL CHECK (reading_value >= 0),
  previous_reading NUMERIC CHECK (previous_reading >= 0),
  consumption NUMERIC GENERATED ALWAYS AS (reading_value - COALESCE(previous_reading, 0)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX utility_readings_meter_id_idx ON utility_readings(meter_id);
CREATE INDEX utility_readings_reading_date_idx ON utility_readings(reading_date);

-- Sent notifications (dedup guard for alert cron)
CREATE TABLE sent_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'critical_date_alert','delinquency_alert','insurance_expiry','cam_due'
  )),
  reference_id UUID NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recipient TEXT NOT NULL,
  UNIQUE(notification_type, reference_id, recipient)
);
