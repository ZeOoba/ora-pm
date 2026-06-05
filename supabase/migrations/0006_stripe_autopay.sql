-- Autopay preference on leases
ALTER TABLE leases
  ADD COLUMN autopay_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN autopay_payment_method_id TEXT;

-- Idempotency guard for Stripe webhook events
CREATE TABLE stripe_webhook_events (
  id TEXT PRIMARY KEY,               -- Stripe event ID (evt_xxx)
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'processed' -- 'processed' | 'failed'
);
