-- Storage bucket RLS policies for tenant portal
-- Applied 2026-06-05 via Node.js db script (buckets created via Supabase Storage REST API)
-- Buckets: lease-documents (private), insurance-certs (private)

-- Tenants may upload COIs to insurance-certs/<their_tenant_id>/
CREATE POLICY tenant_upload_insurance
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'insurance-certs'
  AND EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.auth_user_id = auth.uid()
    AND (storage.foldername(name))[1] = t.id::text
  )
);

-- Tenants may read their own COIs
CREATE POLICY tenant_read_insurance
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'insurance-certs'
  AND EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.auth_user_id = auth.uid()
    AND (storage.foldername(name))[1] = t.id::text
  )
);

-- Tenants may read lease documents for their active leases
-- (admin uploads, tenant reads — no INSERT policy on lease-documents)
CREATE POLICY tenant_read_lease_docs
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'lease-documents'
  AND EXISTS (
    SELECT 1 FROM public.leases l
    JOIN public.tenants t ON t.id = l.tenant_id
    WHERE t.auth_user_id = auth.uid()
    AND (storage.foldername(name))[1] = l.id::text
  )
);
