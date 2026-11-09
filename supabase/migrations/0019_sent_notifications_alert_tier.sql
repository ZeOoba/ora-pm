-- OI-321: critical-date alert dedup per (reference_id, urgency tier), recorded only after a
-- confirmed send.
--
-- Before: /api/cron/critical-dates-alerts inserted one sent_notifications row per
-- (notification_type, reference_id, recipient) BEFORE returning its digest. Two consequences:
-- each lease / insurance certificate alerted exactly once, when it entered the 90-day horizon
-- (the warning / urgent / overdue escalations never fired), and a digest whose Outlook-COM send
-- failed in ping-crons.ps1 was lost for good.
--
-- After (server/routes/cron.ts): the alerts endpoint is read-only and returns an ack_token;
-- POST /api/cron/critical-dates-alerts/ack writes the rows, with alert_tier, only after
-- ping-crons.ps1 confirms the send.
--
-- Deploy order: apply this migration BEFORE deploying the Worker that reads alert_tier. With
-- the migration applied and the OLD Worker still live, behavior is unchanged: it reads and writes
-- rows without alert_tier, and the partial index below keeps its one-row-per-reference guarantee.

ALTER TABLE sent_notifications ADD COLUMN alert_tier TEXT;

-- The four values of the critical_dates view's urgency CASE (0004_views_and_rls.sql). NULL is
-- every other notification_type and every legacy critical_date_alert row.
ALTER TABLE sent_notifications ADD CONSTRAINT sent_notifications_alert_tier_check
  CHECK (alert_tier IS NULL OR alert_tier IN ('overdue', 'urgent', 'warning', 'notice'));

-- The 0003 UNIQUE(notification_type, reference_id, recipient) would block a second tier for the
-- same reference. Named explicitly (Postgres' default name, exactly 63 chars): if it is not
-- there under this name the migration fails, rather than leaving the old key in place, where it
-- would make every escalation ack fail.
ALTER TABLE sent_notifications DROP CONSTRAINT sent_notifications_notification_type_reference_id_recipient_key;

-- The ack's ON CONFLICT target. Tiered rows are unique per tier.
CREATE UNIQUE INDEX sent_notifications_type_ref_recipient_tier_key
  ON sent_notifications (notification_type, reference_id, recipient, alert_tier);

-- Legacy (NULL-tier) rows keep the pre-0019 guarantee: NULLs are distinct in the index above,
-- so without this a second legacy row for the same reference would be accepted.
CREATE UNIQUE INDEX sent_notifications_legacy_untiered_key
  ON sent_notifications (notification_type, reference_id, recipient)
  WHERE alert_tier IS NULL;

-- Backfill: each legacy critical_date_alert row whose date is still in the view takes that
-- date's CURRENT tier, so deploying OI-321 does not re-send every date already alerted. The cost
-- is one escalation: a date first alerted at 'notice' that is 'urgent' today is recorded as
-- 'urgent' and next fires at 'overdue'. A row whose date has left the view stays NULL and
-- suppresses nothing (the date is no longer alertable). Idempotent: only NULL-tier rows change.
UPDATE sent_notifications SET alert_tier = cd.urgency
  FROM critical_dates cd
  WHERE sent_notifications.notification_type = 'critical_date_alert'
    AND sent_notifications.alert_tier IS NULL
    AND cd.reference_id = sent_notifications.reference_id;
