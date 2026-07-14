-- v137: accurate push notification badge counts
--
-- dispatch-notification previously hardcoded badge: 1 on every single push.
-- Apple/Android just stamp the app icon with whatever number the payload
-- says (they don't accumulate it) — so a user who got 3 unread notifications
-- while the app was backgrounded/killed only ever saw "1" on the icon, not
-- "3". profiles.unread_notification_count is a server-tracked per-user
-- running total: dispatch-notification increments it atomically for every
-- recipient and stamps that real number into the push's badge field. The
-- client resets it to 0 (a plain table update, already permitted by the
-- existing "Modifier son profil" policy since auth.uid() = id) whenever the
-- user actually opens the app.

ALTER TABLE profiles ADD COLUMN unread_notification_count INT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION increment_unread_notifications(p_user_ids UUID[])
RETURNS TABLE (id UUID, unread_notification_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE profiles
  SET unread_notification_count = profiles.unread_notification_count + 1
  WHERE profiles.id = ANY(p_user_ids)
  RETURNING profiles.id, profiles.unread_notification_count;
END;
$$;

-- Only dispatch-notification (service role) should ever call this — a
-- regular user calling it directly with an arbitrary id array could inflate
-- someone else's badge count, so it's not left open to anon/authenticated.
-- REVOKE ... FROM PUBLIC alone is not enough here: Supabase's local/hosted
-- Postgres grants EXECUTE on newly created functions directly to
-- anon/authenticated/service_role via default privileges, not merely
-- inherited through PUBLIC, so those two roles must be revoked explicitly
-- (confirmed by an integration test that called this as a plain
-- authenticated user and got no error until this fix).
REVOKE EXECUTE ON FUNCTION increment_unread_notifications(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_unread_notifications(UUID[]) TO service_role;
