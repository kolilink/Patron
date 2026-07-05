-- Move nightly reconciliation from 02:00 UTC → 11:00 UTC (06:00 ET / EST = UTC-5)
-- During EDT (summer, UTC-4) this fires at 07:00 ET — close enough.
UPDATE cron.job
SET schedule = '0 11 * * *'
WHERE jobname = 'patron-nightly-reconciliation';

-- Verify
SELECT jobname, schedule, active
FROM cron.job
WHERE jobname = 'patron-nightly-reconciliation';
