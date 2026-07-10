'use strict';

// Splits a SQL file into individual top-level statements so each can be
// applied independently — a dollar-quote-aware, comment-aware scan for
// top-level semicolons. Needed because Postgres treats a multi-statement
// "simple query" as one implicit transaction: if any statement fails, every
// statement in that message rolls back, even unrelated ones that succeeded.
// When replaying migration history from scratch, one already-applied
// statement in a file must not sink a genuinely new statement sitting next
// to it in the same file.
function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    // Line comment
    if (c === '-' && sql[i + 1] === '-') {
      i = sql.indexOf('\n', i);
      i = i === -1 ? n : i + 1;
      continue;
    }

    // Block comment (Postgres allows nesting)
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }

    // Single-quoted string ('' is an escaped quote)
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }

    // Double-quoted identifier ("" is an escaped quote)
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    // Dollar-quoted string: $$ ... $$ or $tag$ ... $tag$
    if (c === '$') {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }

    // Top-level statement terminator
    if (c === ';') {
      const stmt = sql.slice(start, i + 1).trim();
      if (stmt) statements.push(stmt);
      start = i + 1;
      i++;
      continue;
    }

    i++;
  }

  const rest = sql.slice(start).trim();
  if (rest) statements.push(rest);

  return statements;
}

module.exports = { splitSqlStatements };
