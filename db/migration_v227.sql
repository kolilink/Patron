-- ============================================================
-- Patron — Migration v227
-- Run in Supabase SQL Editor AFTER migration_v226
--
-- Team feature flag: businesses.teams_enabled.
--
-- Équipe (teams), Apports (money injection) and the Ma Boutique team-chat
-- tab are gated behind a per-business flag. Default OFF for new businesses.
-- VISIBILITY ONLY: nothing is deleted or restricted server-side — memberships,
-- capital_injections and chat history are untouched, and every existing RPC /
-- RLS policy behaves exactly as before. The client simply hides the entry
-- points while the flag is false (src/utils/teamsFlag.ts), and fails OPEN
-- (shows everything) whenever the flag is missing/undefined.
--
-- Backfill (same migration, so nobody who already uses these features loses
-- them): a business is switched ON if it has
--   * more than one member, OR
--   * any apports row (capital_injections — injections and withdrawals), OR
--   * any Ma Boutique chat message (a message in a non-global, non-DM room of
--     that business — Le Marché and partner DM rooms don't count).
-- Everyone else (solo businesses with no apports and no team chat) stays OFF.
-- ============================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS teams_enabled boolean NOT NULL DEFAULT false;

UPDATE businesses b
SET teams_enabled = true
WHERE b.teams_enabled = false
  AND (
    (SELECT count(*) FROM memberships m WHERE m.business_id = b.id) > 1
    OR EXISTS (SELECT 1 FROM capital_injections ci WHERE ci.business_id = b.id)
    OR EXISTS (
      SELECT 1
      FROM chat_messages cm
      JOIN chat_rooms cr ON cr.id = cm.room_id
      WHERE cr.business_id = b.id
        AND cr.is_global = false
        AND cr.partnership_id IS NULL
    )
  );
