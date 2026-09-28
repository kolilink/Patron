-- ============================================================
-- Patron — Migration v192
-- Run in Supabase SQL Editor AFTER migration_v191
--
-- Removes the Alpha WhatsApp re-engagement reminder feature entirely, on
-- direct product decision (2026-09-27): messaging merchants on WhatsApp to
-- push a paid upgrade isn't something the product wants to do. This is a
-- full removal, not a pause — the edge function (send-alpha-whatsapp-reminder),
-- its client-side consent prompt (app/(app)/alpha/index.tsx's "On vous
-- facilite ça ?" AppSheet, stores/alpha.ts's checkWhatsappConsentEligibility/
-- recordWhatsappConsent) are deleted in the same change. See CLAUDE.md's
-- "Alpha WhatsApp reminder" section for what this used to do.
--
-- Unschedules the daily cron first — dropping the functions it calls while
-- the job is still scheduled would just make tonight's run fail instead of
-- not existing.
-- ============================================================

SELECT cron.unschedule('patron-alpha-whatsapp-reminder');

DROP FUNCTION IF EXISTS get_and_mark_alpha_whatsapp_candidates();
DROP FUNCTION IF EXISTS alpha_whatsapp_reminder_eligible_now(uuid);
DROP FUNCTION IF EXISTS record_alpha_whatsapp_consent(uuid, boolean);

DROP TABLE IF EXISTS alpha_whatsapp_reminders_sent;

ALTER TABLE profiles DROP COLUMN IF EXISTS alpha_whatsapp_consent;
