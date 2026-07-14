#!/usr/bin/env node
'use strict';

// Builds a throwaway local Postgres database (via `supabase start`) with the
// full production schema applied, so integration tests can call the real
// submit_sale / cancel_sale / join_business SQL functions instead of a
// mocked supabase.rpc(). Idempotent — safe to re-run before each test run.
//
// Requires: `supabase start` already running (npm run test:db:start).

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { splitSqlStatements } = require('./lib/split-sql');

const ROOT = path.resolve(__dirname, '..');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

// db/schema.sql documents cumulative current state, while individual
// migration_vN.sql files document what actually ran, once, against
// production at the time. Replaying the full history from an empty
// database (something production itself never does) hits two classes of
// benign failure that aren't real bugs:
//   - "already exists": schema.sql already created the object (file drift
//     between the cumulative snapshot and the incremental history).
//   - "does not exist" on production-only extension schemas (pg_cron's
//     `cron.*`, etc.) that local dev doesn't enable and these tests don't
//     exercise (e.g. migration_v123 just unschedules a cron job).
const BENIGN_DUPLICATE_CODES = new Set([
  '42710', // duplicate_object
  '42701', // duplicate_column
  '42P07', // duplicate_table
  '42P06', // duplicate_schema
  '42723', // duplicate_function
  '3F000', // undefined_schema (e.g. pg_cron's `cron` schema, not enabled locally)
]);

function migrationFiles() {
  return fs.readdirSync(path.join(ROOT, 'db'))
    .filter(f => /^migration_v\d+\.sql$/.test(f))
    .map(f => ({ file: f, version: parseInt(f.match(/^migration_v(\d+)\.sql$/)[1], 10) }))
    .sort((a, b) => a.version - b.version)
    .map(x => x.file);
}

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  try {
    console.log('Resetting public schema...');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');

    // Recreating the schema drops the role grants Supabase's Postgres image
    // normally sets up once at cluster init (supabase start doesn't redo
    // this on an existing volume) — without these, PostgREST's anon/
    // authenticated roles get "permission denied for schema public" on
    // every request.
    await client.query(`
      GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
      GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, anon, authenticated, service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO postgres, anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
    `);

    console.log('Applying db/schema.sql...');
    await client.query(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf-8'));

    const files = migrationFiles();
    let skippedStatements = 0;
    for (const file of files) {
      const sql = fs.readFileSync(path.join(ROOT, 'db', file), 'utf-8');
      // Applied statement-by-statement, not as one multi-statement query:
      // Postgres treats a multi-statement simple-query message as a single
      // implicit transaction, so one benign "already exists" statement
      // would otherwise roll back sibling statements in the same file that
      // are genuinely new (this bit us on migration_v90 — the new
      // message_type column was reverted along with an already-applied
      // policy statement further down the same file).
      const statements = splitSqlStatements(sql);
      let fileSkipped = 0;
      for (const stmt of statements) {
        try {
          await client.query(stmt);
        } catch (err) {
          if (BENIGN_DUPLICATE_CODES.has(err.code)) {
            fileSkipped++;
            skippedStatements++;
            continue;
          }
          console.error(`\n✗ Failed applying a statement in ${file}:\n${err.message}\n\n${stmt.slice(0, 300)}\n`);
          throw err;
        }
      }
      process.stdout.write(fileSkipped
        ? `  -> ${file}  (${fileSkipped}/${statements.length} statements skipped as already-present)\n`
        : `  -> ${file}\n`);
    }

    console.log(`✓ Local test database ready (${files.length} migrations applied, ${skippedStatements} statements skipped as already-present) at ${DB_URL}`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
