-- AR Ledger view: per-lease balance = total charges - settled payments
CREATE OR REPLACE VIEW ar_ledger AS
SELECT
  l.id AS lease_id,
  l.tenant_id,
  l.unit_id,
  t.name AS tenant_name,
  u.property_id,
  u.suite,
  COALESCE(SUM(c.amount), 0) AS total_charged,
  COALESCE(SUM(
    CASE
      WHEN p.method = 'ach_stripe' AND p.stripe_status = 'succeeded' THEN p.amount
      WHEN p.method IN ('check','wire','other') THEN p.amount
      ELSE 0
    END
  ), 0) AS total_paid,
  COALESCE(SUM(c.amount), 0) - COALESCE(SUM(
    CASE
      WHEN p.method = 'ach_stripe' AND p.stripe_status = 'succeeded' THEN p.amount
      WHEN p.method IN ('check','wire','other') THEN p.amount
      ELSE 0
    END
  ), 0) AS balance
FROM leases l
JOIN tenants t ON t.id = l.tenant_id
JOIN units u ON u.id = l.unit_id
LEFT JOIN charges c ON c.lease_id = l.id
LEFT JOIN payments p ON p.lease_id = l.id
GROUP BY l.id, l.tenant_id, l.unit_id, t.name, u.property_id, u.suite;

-- Rent Roll view: all units with current active lease data
CREATE OR REPLACE VIEW rent_roll AS
SELECT
  p.id AS property_id,
  p.name AS property_name,
  u.id AS unit_id,
  u.suite,
  u.sf,
  u.status AS unit_status,
  t.id AS tenant_id,
  t.name AS tenant_name,
  l.id AS lease_id,
  l.start_date,
  l.end_date,
  l.status AS lease_status,
  l.rent_type,
  l.base_rent_monthly,
  l.cam_estimate_monthly,
  l.base_rent_monthly + l.cam_estimate_monthly AS total_monthly,
  ROUND((l.base_rent_monthly * 12) / NULLIF(u.sf, 0), 2) AS rent_psf_annual
FROM units u
JOIN properties p ON p.id = u.property_id
LEFT JOIN leases l ON l.unit_id = u.id AND l.status = 'active'
LEFT JOIN tenants t ON t.id = l.tenant_id;

-- Critical Dates view: lease expirations + insurance expiries within 90 days
CREATE OR REPLACE VIEW critical_dates AS
SELECT
  'lease_expiration' AS date_type,
  l.id AS reference_id,
  t.name AS tenant_name,
  p.name AS property_name,
  u.suite,
  l.end_date AS critical_date,
  (l.end_date - CURRENT_DATE) AS days_until,
  CASE
    WHEN l.end_date < CURRENT_DATE THEN 'overdue'
    WHEN l.end_date - CURRENT_DATE <= 30 THEN 'urgent'
    WHEN l.end_date - CURRENT_DATE <= 60 THEN 'warning'
    ELSE 'notice'
  END AS urgency
FROM leases l
JOIN tenants t ON t.id = l.tenant_id
JOIN units u ON u.id = l.unit_id
JOIN properties p ON p.id = u.property_id
WHERE l.status = 'active' AND l.end_date <= CURRENT_DATE + INTERVAL '90 days'

UNION ALL

SELECT
  'insurance_expiry' AS date_type,
  ic.id AS reference_id,
  t.name AS tenant_name,
  NULL AS property_name,
  NULL AS suite,
  ic.expiration_date AS critical_date,
  (ic.expiration_date - CURRENT_DATE) AS days_until,
  CASE
    WHEN ic.expiration_date < CURRENT_DATE THEN 'overdue'
    WHEN ic.expiration_date - CURRENT_DATE <= 30 THEN 'urgent'
    WHEN ic.expiration_date - CURRENT_DATE <= 60 THEN 'warning'
    ELSE 'notice'
  END AS urgency
FROM insurance_certificates ic
JOIN tenants t ON t.id = ic.tenant_id
WHERE ic.expiration_date <= CURRENT_DATE + INTERVAL '90 days'

ORDER BY days_until ASC;

-- Row Level Security: enable on tenant-facing tables
ALTER TABLE charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_amendments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_certificates ENABLE ROW LEVEL SECURITY;

-- Policy: tenants can only SELECT their own charges
CREATE POLICY "tenant_own_charges" ON charges
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM leases l
      JOIN tenants t ON t.id = l.tenant_id
      WHERE l.id = charges.lease_id
      AND t.auth_user_id = auth.uid()
    )
  );

-- Policy: tenants can only SELECT their own payments
CREATE POLICY "tenant_own_payments" ON payments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM leases l
      JOIN tenants t ON t.id = l.tenant_id
      WHERE l.id = payments.lease_id
      AND t.auth_user_id = auth.uid()
    )
  );

-- Policy: tenants can only SELECT their own lease documents
CREATE POLICY "tenant_own_documents" ON lease_documents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM leases l
      JOIN tenants t ON t.id = l.tenant_id
      WHERE l.id = lease_documents.lease_id
      AND t.auth_user_id = auth.uid()
    )
  );

-- Policy: tenants can only SELECT their own amendments
CREATE POLICY "tenant_own_amendments" ON lease_amendments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM leases l
      JOIN tenants t ON t.id = l.tenant_id
      WHERE l.id = lease_amendments.lease_id
      AND t.auth_user_id = auth.uid()
    )
  );

-- Policy: tenants can only SELECT their own notices
CREATE POLICY "tenant_own_notices" ON tenant_notices
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM leases l
      JOIN tenants t ON t.id = l.tenant_id
      WHERE l.id = tenant_notices.lease_id
      AND t.auth_user_id = auth.uid()
    )
  );

-- Policy: tenants can only SELECT their own insurance certificates
-- AND can INSERT their own (for COI upload in tenant portal Phase 2)
CREATE POLICY "tenant_own_insurance_select" ON insurance_certificates
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenants t
      WHERE t.id = insurance_certificates.tenant_id
      AND t.auth_user_id = auth.uid()
    )
  );

CREATE POLICY "tenant_own_insurance_insert" ON insurance_certificates
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tenants t
      WHERE t.id = insurance_certificates.tenant_id
      AND t.auth_user_id = auth.uid()
    )
  );
