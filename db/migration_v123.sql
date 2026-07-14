-- ============================================================
-- Patron — Migration v123
-- Run in Supabase SQL Editor AFTER migration_v122
--
-- Retires the standalone 2am UTC reconciliation email. The founder now gets
-- exactly ONE combined daily report at 6:00 AM ET (10:00 UTC), sent by the
-- "Patron — Rapport Quotidien" cloud routine via the send-report-email relay
-- (include_reconciliation:true) — see supabase/functions/send-report-email
-- and supabase/functions/_shared/reconciliation.ts. That relay call runs the
-- exact same run_reconciliation() + run_display_checks() +
-- refresh_reconciliation_run() + get_financial_snapshot() sequence this cron
-- job used to trigger, so no reconciliation coverage is lost — only the
-- separate 2am email is removed.
--
-- send-reconciliation-report itself is left deployed and callable (manual/
-- debug use, e.g. re-running a check right after a fix) — only the pg_cron
-- schedule that invoked it automatically every night is removed here.
-- ============================================================

SELECT cron.unschedule('patron-nightly-reconciliation');
