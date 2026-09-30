-- ============================================================
-- Patron — Migration v191
-- Run in Supabase SQL Editor AFTER migration_v190
--
-- Cleanup: drops otp_codes (migration_v8.sql), a superseded WhatsApp-OTP
-- table from before the phone_verifications/create-phone-verification/
-- verify-phone-code flow existed (see migration_v9.sql's own comment:
-- "Replaces otp_codes for the new zero-cost inbound flow"). Its only two
-- readers/writers — the verify-phone-otp and send-whatsapp-otp edge
-- functions — have been deleted from the repo; confirmed via
-- `supabase functions list` that neither was ever actually deployed to
-- production in the first place (security audit 2026-09-27). Nothing else
-- in the codebase references this table — no FKs in either direction.
-- ============================================================

DROP TABLE IF EXISTS otp_codes;
