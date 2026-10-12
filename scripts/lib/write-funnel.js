// Finds direct Supabase table writes (`.from(x).insert|update|upsert|delete(`) outside the write pipeline.
// A hit is allowed when (a) the file is part of the pipeline, (b) a `funnel-exempt: <reason>` comment sits in
// the 4 lines above the call, or (c) the file is in LEGACY with a ceiling that may only go DOWN.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PIPELINE = new Set(['lib/sync.ts', 'lib/writeFunnel.ts', 'lib/db.ts', 'lib/db.web.ts', 'lib/outbox.ts', 'lib/rowWriteExec.ts']);
const WRITE_RE = /\.from\(\s*['"`][\w.]+['"`]\s*\)[\s\S]{0,160}?\.(insert|update|upsert|delete)\(/g;

// Debt ledger: direct writes that predate the funnel and are NOT migrated yet. Ceilings only go down.
// (stores/auth.ts is auth/session plumbing — exempt in spirit; listed so it is counted, not forgotten.)
const LEGACY = {
  'stores/auth.ts': 8,
  'stores/equipe.ts': 10,
  'stores/fournisseurs.ts': 8,
  'stores/market.ts': 1,
  'stores/ventes.ts': 1,
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.git', '__tests__'].includes(e.name)) walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

function findDirectWriteViolations() {
  const perFile = {};
  const violations = [];
  for (const top of ['app', 'src', 'lib', 'stores']) {
    for (const abs of walk(path.join(ROOT, top))) {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      if (PIPELINE.has(rel)) continue;
      const src = fs.readFileSync(abs, 'utf8');
      let m;
      WRITE_RE.lastIndex = 0;
      while ((m = WRITE_RE.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length;
        const above = src.split('\n').slice(Math.max(0, line - 5), line).join('\n');
        if (/funnel-exempt:\s*\S/.test(above)) continue;
        (perFile[rel] = perFile[rel] || []).push(line);
      }
    }
  }
  for (const [rel, lines] of Object.entries(perFile)) {
    const ceiling = LEGACY[rel] ?? 0;
    if (lines.length > ceiling) violations.push({ file: rel, count: lines.length, ceiling, lines });
  }
  return { violations, perFile, LEGACY };
}

module.exports = { findDirectWriteViolations, LEGACY, PIPELINE };
