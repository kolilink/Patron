-- Notification launch allowlist: per-recipient push log, used to enforce the
-- "max 3 ordinary/money pushes per user per rolling 24h" server-side cap in
-- dispatch-notification. The existing notification_log table is one row per
-- DISPATCH CALL (covering however many recipients matched), not one row per
-- recipient, so it can't answer "how many pushes has this specific user had
-- in the last 24h" without a per-recipient table.
--
-- service_role only — this is internal bookkeeping for the edge function,
-- never read or written by the client.
create table if not exists push_recipient_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  event_type text not null,
  category text not null check (category in ('security', 'money', 'ordinary')),
  sent_at timestamptz not null default now()
);

create index if not exists push_recipient_log_user_recent_idx
  on push_recipient_log (user_id, sent_at desc);

alter table push_recipient_log enable row level security;

revoke all on push_recipient_log from public, anon, authenticated;
grant all on push_recipient_log to service_role;
grant usage, select on sequence push_recipient_log_id_seq to service_role;
