-- OI-321: critical-date alert dedup per (reference_id, urgency tier, critical date), recorded only
-- after a confirmed send.
--
-- Before: /api/cron/critical-dates-alerts inserted one sent_notifications row per
-- (notification_type, reference_id, recipient) BEFORE returning its digest. Three consequences:
-- each lease / insurance certificate alerted exactly once, when it entered the 90-day horizon
-- (the warning / urgent / overdue escalations never fired); a date edited in place (a lease
-- extended by changing end_date) never alerted again; and a digest whose Outlook-COM send failed
-- in ping-crons.ps1 was lost for good.
--
-- After (server/routes/cron.ts): the alerts endpoint is read-only and returns an ack_token;
-- POST /api/cron/critical-dates-alerts/ack writes the rows, tagged with alert_tier + alert_date,
-- only after ping-crons.ps1 confirms the send.
--
-- Deploy order: apply this migration BEFORE deploying the Worker that reads the new columns. With
-- the migration applied and the OLD Worker still live, behavior is unchanged: it reads and writes
-- untagged rows, and the partial index below keeps its one-row-per-reference guarantee.

ALTER TABLE sent_notifications ADD COLUMN alert_tier TEXT;
ALTER TABLE sent_notifications ADD COLUMN alert_date DATE;

-- The four values of the critical_dates view's urgency CASE (0004_views_and_rls.sql). NULL is
-- every other notification_type and every legacy critical_date_alert row.
ALTER TABLE sent_notifications ADD CONSTRAINT sent_notifications_alert_tier_check
  CHECK (alert_tier IS NULL OR alert_tier IN ('overdue', 'urgent', 'warning', 'notice'));

-- A row is either tagged (tier AND date) or legacy (neither).
ALTER TABLE sent_notifications ADD CONSTRAINT sent_notifications_alert_tag_pair_check
  CHECK ((alert_tier IS NULL) = (alert_date IS NULL));

-- The 0003 UNIQUE(notification_type, reference_id, recipient) would block a second tier or date
-- for the same reference. Named explicitly (Postgres' default name, exactly 63 chars, so not
-- truncated): if it is not there under this name the migration fails, rather than leaving the
-- old key in place, where it would make every escalation ack fail.
ALTER TABLE sent_notifications DROP CONSTRAINT sent_notifications_notification_type_reference_id_recipient_key;

-- The ack's ON CONFLICT target. Tagged rows are unique per (tier, date).
CREATE UNIQUE INDEX sent_notifications_type_ref_recipient_tier_date_key
  ON sent_notifications (notification_type, reference_id, recipient, alert_tier, alert_date);

-- Legacy (untagged) rows keep the pre-0019 guarantee: NULLs are distinct in the index above, so
-- without this a second legacy row for the same reference would be accepted.
CREATE UNIQUE INDEX sent_notifications_legacy_untagged_key
  ON sent_notifications (notification_type, reference_id, recipient)
  WHERE alert_tier IS NULL;

-- Backfill: each legacy critical_date_alert row whose date is still in the view is tagged with
-- that date and the tier it had WHEN THE ALERT WAS SENT (critical_date vs sent_at, the view's
-- thresholds), so the deploy re-sends nothing that was delivered, and every escalation since
-- (notice at send, urgent today) fires once. Tagging with today's tier instead would silently
-- drop exactly those escalations. A row whose date has left the view stays untagged and
-- suppresses nothing (the date is no longer alertable). Idempotent: only untagged rows change.
UPDATE sent_notifications
  SET alert_tier = CASE
        WHEN cd.critical_date < sent_notifications.sent_at::date THEN 'overdue'
        WHEN cd.critical_date <= sent_notifications.sent_at::date + 30 THEN 'urgent'
        WHEN cd.critical_date <= sent_notifications.sent_at::date + 60 THEN 'warning'
        ELSE 'notice'
      END,
      alert_date = cd.critical_date
  FROM critical_dates cd
  WHERE sent_notifications.notification_type = 'critical_date_alert'
    AND sent_notifications.alert_tier IS NULL
    AND cd.reference_id = sent_notifications.reference_id;
