'use strict';

// One visibility rule for expenses (migration_v235): a function may only READ
// expenses through the `expenses_visible` view, never the base table.
//
// Why it is a guard and not a convention: SECURITY DEFINER bodies bypass RLS,
// so the restrictive "deleted_at IS NULL" policy on the table (v234) does not
// protect them. A view's WHERE does apply inside a definer body, but only if
// the function actually reads the view — so a new function that selects from
// `expenses` would silently count soft-deleted rows in a total. This check
// fails the build when the latest definition of any function does that.
//
// "Read" = SELECT-style access: `FROM expenses` / `JOIN expenses` / a comma
// join. INSERT INTO / UPDATE / DELETE FROM targets are writes, not reads, and
// are not matched (an account purge must delete tombstones too).

const path = require('path');
const { buildFunctionState } = require('./function-exposure');

const DEFAULT_DB_DIR = path.resolve(__dirname, '..', '..', 'db');

// The soft-delete tombstone RPCs must see deleted rows by definition
// (restore_expense reads a row the view hides). Nothing else belongs here.
const EXPENSE_READ_ALLOWLIST = {
  soft_delete_expense: 'reads the row it is about to tombstone, including an already-deleted one (idempotent)',
  restore_expense: 'must read the soft-deleted row it brings back',
  decide_expense: 'must see a soft-deleted row in order to refuse deciding it',
};

const EXPENSE_READ = /(?<!\bDELETE\s)\b(?:FROM|JOIN)\s+(?:public\.)?"?expenses"?(?![\w])|,\s*(?:public\.)?"?expenses"?(?![\w])/i;

/** entries: [{ name, body, file? }] → violation strings. Pure; unit-tested on synthetic bodies. */
function findExpenseReadViolationsIn(entries, allowlist = EXPENSE_READ_ALLOWLIST) {
  const out = [];
  for (const e of entries) {
    if (Object.prototype.hasOwnProperty.call(allowlist, e.name)) continue;
    if (EXPENSE_READ.test(e.body)) {
      out.push(`${e.file ? `db/${e.file}: ` : ''}${e.name} reads the expenses table directly — read expenses_visible instead (soft-deleted rows would be counted)`);
    }
  }
  return out.sort();
}

/** Static scan of db/: the latest definition of every function. */
function findExpenseVisibilityViolations(dbDir = DEFAULT_DB_DIR) {
  const entries = [];
  for (const fn of buildFunctionState(dbDir).values()) {
    entries.push({ name: fn.name, body: fn.body, file: fn.file });
  }
  return findExpenseReadViolationsIn(entries);
}

module.exports = { findExpenseReadViolationsIn, findExpenseVisibilityViolations, EXPENSE_READ_ALLOWLIST, EXPENSE_READ };
