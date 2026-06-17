-- Migration v64: Add phone column to businesses table
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phone text;
