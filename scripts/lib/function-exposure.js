'use strict';

// Rule: every function defined under db/ must EITHER have EXECUTE revoked from
// `anon` OR contain an auth check in its body (or be a trigger function, which
// is not callable as an RPC) — otherwise the build fails.
//
// Why this exists: Supabase grants EXECUTE on every new public function
// directly to anon/authenticated (default privileges), and a SECURITY DEFINER
// body bypasses RLS. A function with no auth check and no REVOKE is therefore
// callable by anyone holding the public anon key. This shipped repeatedly
// (get_financial_snapshot, get_best_sellers, get_order_cogs, the reconciliation
// job functions, get_int_setting/get_text_setting, get_reports_snapshot /
// get_period_report's anon path…) — it must become impossible to add another
// one without a conscious, reviewed decision.
//
// Gotcha encoded here, BOTH halves: a new function gets EXECUTE through PUBLIC
// *and* through a direct grant to anon (Supabase default privileges). So
// `REVOKE ... FROM PUBLIC` alone does NOT close it (anon's direct grant stays),
// and `REVOKE ... FROM anon` alone does NOT close it either (the PUBLIC grant
// still reaches anon) — create_demo_business shipped exactly that way. Both
// must be revoked (in one statement or two) for the function to count as closed.
// Overloads are tracked separately (by normalized type signature): a safe 5-arg
// overload must not hide a stale, unguarded 3-arg one, and DROPping one overload
// must not erase another with the same number of arguments.
//
// Static text analysis of the SQL files, replayed in order (CREATE OR REPLACE
// keeps grants; a later GRANT to anon/PUBLIC re-exposes). A backstop test
// (__tests__/integration/function-exposure-live.integration.test.ts) applies
// the same rule to the real post-replay pg_proc ACLs.

const fs = require('fs');
const path = require('path');
const { splitSqlStatements } = require('./split-sql');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DB_DIR = path.join(ROOT, 'db');

// Body contains one of these → the function authenticates/authorizes its caller.
const AUTH_CHECK = new RegExp([
  '\\bauth\\.uid\\s*\\(',
  '\\bauth\\.role\\s*\\(',
  '\\bauth\\.jwt\\s*\\(',
  '\\bis_member\\s*\\(',
  '\\bget_role\\s*\\(',
  '\\bis_founder\\s*\\(',
  '\\bshares_business_with\\s*\\(',
  "current_setting\\s*\\(\\s*'request\\.jwt",
].join('|'), 'i');

// Functions that are reachable by anon on purpose, or are pure helpers with no
// data access. Each entry needs a reason; adding one is a reviewed decision.
// (Keep this list short — fix the function instead whenever possible.)
const EXPOSURE_ALLOWLIST = {
  preview_consumer_invite:
    'Public invite landing page (supabase/functions/invite) calls it with the anon key; returns only {valid, inviter_name}.',
  preview_consumer_invite_code:
    'Same public invite landing page, code variant; returns only {valid, inviter_name}.',
  preview_inviter:
    'Public word-of-mouth invite landing page (invite/index.html) calls it with the anon key; returns only {valid, inviter_name}.',
};

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function migrationFiles(dbDir) {
  const files = fs.readdirSync(dbDir).filter(f => /^migration_v\d+\.sql$/.test(f));
  files.sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const ordered = [];
  if (fs.existsSync(path.join(dbDir, 'schema.sql'))) ordered.push('schema.sql');
  return ordered.concat(files);
}

const TYPE_ALIASES = {
  int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint', bool: 'boolean',
  float8: 'double precision', float4: 'real', varchar: 'character varying', timestamptz: 'timestamp with time zone',
  'character varying': 'character varying',
};

function normType(t) {
  let x = t.toLowerCase().replace(/\bpublic\./g, '').replace(/\s+/g, ' ').trim();
  x = x.replace(/\(\s*\d+(\s*,\s*\d+)?\s*\)/g, '');            // numeric(10,2) -> numeric
  const arr = x.endsWith('[]') ? '[]' : '';
  if (arr) x = x.slice(0, -2).trim();
  return (TYPE_ALIASES[x] || x) + arr;
}

// Splits the text of a parameter list at top-level commas.
function splitParams(inner) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Text between the "(" at `open` and its matching ")".
function parenInner(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') { depth--; if (depth === 0) return text.slice(open + 1, i); }
  }
  return text.slice(open + 1);
}

// Normalized type signature of a parameter list. `named` = CREATE FUNCTION
// params ("p_limit integer DEFAULT 5"); otherwise ACL/DROP params (types only).
function signatureOf(inner, named) {
  return splitParams(inner).map(raw => {
    let x = raw.replace(/\b(DEFAULT\b|=).*$/is, '').trim();
    x = x.replace(/^(IN|OUT|INOUT|VARIADIC)\s+/i, '');
    if (named) {
      const toks = x.split(/\s+/);
      if (toks.length > 1) x = toks.slice(1).join(' ');
    }
    return normType(x);
  }).filter(Boolean).join(',');
}

const NAME_RE = /(?:\bpublic\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/g;

// "name(uuid, uuid[])" → ["name(uuid,uuid[])"]; a bare "name" → ["name/*"].
function keysIn(fragment) {
  const out = [];
  let m;
  NAME_RE.lastIndex = 0;
  while ((m = NAME_RE.exec(fragment))) {
    const open = m.index + m[0].length - 1;
    out.push(`${m[1].toLowerCase()}(${signatureOf(parenInner(fragment, open), false)})`);
    NAME_RE.lastIndex = open + 1 + parenInner(fragment, open).length; // skip past this param list
  }
  if (!out.length) {
    const bare = fragment.trim().match(/^(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?$/);
    if (bare) out.push(`${bare[1].toLowerCase()}/*`);
  }
  return out;
}

// Replays db/ in order and returns Map<"name(type,type,...)", { name, file, body, isTrigger,
// revokedPublic, revokedAnon }>. A function is CLOSED only when BOTH are true.
function buildFunctionState(dbDir = DEFAULT_DB_DIR) {
  const fns = new Map();
  const defaults = { revokedPublic: false, revokedAnon: false };

  const apply = (keys, patch) => {
    for (const k of keys) {
      if (k.endsWith('/*')) {
        const name = k.slice(0, -2);
        for (const fn of fns.values()) if (fn.name === name) Object.assign(fn, patch);
      } else if (fns.has(k)) {
        Object.assign(fns.get(k), patch);
      }
    }
  };

  for (const file of migrationFiles(dbDir)) {
    const sql = fs.readFileSync(path.join(dbDir, file), 'utf8');
    for (const raw of splitSqlStatements(sql)) {
      const stmt = stripSqlComments(raw).trim();
      if (!stmt) continue;

      let m = stmt.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/i);
      if (m) {
        const name = m[1].toLowerCase();
        const key = `${name}(${signatureOf(parenInner(stmt, m[0].length - 1), true)})`;
        const prev = fns.get(key);
        fns.set(key, {
          name,
          file,
          body: stmt,
          isTrigger: /\bRETURNS\s+(event_)?trigger\b/i.test(stmt),
          // CREATE OR REPLACE keeps the existing ACL; a brand-new function
          // inherits default privileges.
          revokedPublic: prev ? prev.revokedPublic : defaults.revokedPublic,
          revokedAnon: prev ? prev.revokedAnon : defaults.revokedAnon,
        });
        continue;
      }

      m = stmt.match(/^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\s\S]+?);?$/i);
      if (m) {
        for (const k of keysIn(m[1])) {
          if (k.endsWith('/*')) {
            for (const [key, fn] of [...fns]) if (fn.name === k.slice(0, -2)) fns.delete(key);
          } else {
            fns.delete(k);
          }
        }
        continue;
      }

      m = stmt.match(/^(REVOKE|GRANT)\b([\s\S]*?)\bON\s+(?:ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+\w+|FUNCTION\s+([\s\S]*?))\s+(FROM|TO)\s+([\s\S]+?);?$/i);
      if (m) {
        const revoke = m[1].toUpperCase() === 'REVOKE';
        const target = m[3];                       // undefined for ALL FUNCTIONS IN SCHEMA
        const grantees = m[5].toLowerCase().split(/[\s,]+/).filter(Boolean);
        if (!/\ball\b|\bexecute\b/.test(m[2].toLowerCase())) continue;
        const patch = {};
        if (grantees.includes('public')) patch.revokedPublic = revoke;
        if (grantees.includes('anon')) patch.revokedAnon = revoke;
        if (!Object.keys(patch).length) continue;
        apply(target ? keysIn(target) : [...fns.keys()], patch);
        continue;
      }

      m = stmt.match(/^ALTER\s+DEFAULT\s+PRIVILEGES\b[\s\S]*?\b(REVOKE|GRANT)\b[\s\S]*?\bON\s+FUNCTIONS\b[\s\S]*?\b(FROM|TO)\s+([\s\S]+?);?$/i);
      if (m) {
        const revoke = m[1].toUpperCase() === 'REVOKE';
        const grantees = m[3].toLowerCase().split(/[\s,]+/).filter(Boolean);
        if (grantees.includes('public')) defaults.revokedPublic = revoke;
        if (grantees.includes('anon')) defaults.revokedAnon = revoke;
      }
    }
  }
  return fns;
}

function findFunctionExposureViolations(dbDir = DEFAULT_DB_DIR) {
  const violations = [];
  for (const [key, fn] of buildFunctionState(dbDir)) {
    if (fn.isTrigger) continue;
    if (fn.revokedPublic && fn.revokedAnon) continue;                 // closed
    if (Object.prototype.hasOwnProperty.call(EXPOSURE_ALLOWLIST, fn.name)) continue;
    if (AUTH_CHECK.test(fn.body)) continue;
    const open = !fn.revokedPublic && !fn.revokedAnon ? 'neither PUBLIC nor anon revoked'
      : !fn.revokedAnon ? 'anon not revoked (REVOKE ... FROM PUBLIC alone leaves anon\'s direct grant)'
      : 'PUBLIC not revoked (REVOKE ... FROM anon alone leaves the PUBLIC grant)';
    violations.push(`db/${fn.file}: ${key} — executable by anon (${open}) and its body has no auth check (auth.uid / is_member / get_role / is_founder / ...)`);
  }
  return violations.sort();
}

module.exports = { findFunctionExposureViolations, buildFunctionState, AUTH_CHECK, EXPOSURE_ALLOWLIST, stripSqlComments };
