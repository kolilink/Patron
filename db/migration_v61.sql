-- migration v61: ensure is_system column exists on products
--
-- migration v59 added this column but v60 only replaced the RPC functions
-- without re-adding the column. If v59 was never run (or was skipped),
-- submit_carnet_debt fails because the column does not exist.
-- This migration is idempotent — safe to run even if v59 was already applied.

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
