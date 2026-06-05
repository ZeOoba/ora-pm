-- Add CHECK constraint to stripe_webhook_events.status
ALTER TABLE stripe_webhook_events
  ADD CONSTRAINT stripe_webhook_events_status_check
  CHECK (status IN ('processed', 'failed'));

-- Add index on event_type for efficient querying
CREATE INDEX idx_stripe_webhook_events_event_type
  ON stripe_webhook_events (event_type);
