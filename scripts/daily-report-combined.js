#!/usr/bin/env node
'use strict';

// Replaces the "Patron — Rapport Quotidien Combiné" Claude cloud routine,
// which POSTed this same payload to the send-report-email relay but was
// silently blocked by the cloud sandbox's egress policy (403 on every
// outbound call to *.supabase.co) for weeks — see CLAUDE.md. GitHub Actions
// runners have unrestricted outbound access, so this workflow does the same
// job (code-quality checks + migration drift + POST to the relay) with no
// dependency on that policy.
//
// The relay (supabase/functions/send-report-email) generates the
// reconciliation/financial half itself (78 DB checks, business/shop counts,
// etc.) server-side when include_reconciliation is true — this script only
// produces the code-quality + migration section below it, same contract the
// cloud routine used.
//
// PostHog analytics/device sections (D/E in the old routine prompt) are not
// reproduced here — they need a PostHog personal API key this workflow
// doesn't have yet, and were already broken in the cloud routine (its
// scheduled runs never had an authorized MCP session either). Rendered as an
// honest "not available" placeholder instead of faking a check.

const { execSync, spawnSync } = require('child_process');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const { findHexViolations } = require('./lib/consistency-checks');

const ROOT          = process.cwd();
const RELAY_SECRET  = process.env.REPORT_RELAY_SECRET;
const RELAY_HOST    = 'jnxpujsyvbenqgjbvifh.supabase.co';
const RELAY_PATH    = '/functions/v1/send-report-email';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── A1. TypeScript ─────────────────────────────────────────────────────────
const tsc     = spawnSync('npx', ['tsc', '--noEmit'], { cwd: ROOT, encoding: 'utf-8' });
const tsOk    = tsc.status === 0;
const tsLines = (tsc.stdout + tsc.stderr).trim().split('\n').filter(Boolean);

// ─── A2. Hardcoded hex colours ──────────────────────────────────────────────
const hexLines = findHexViolations();

// ─── A3. Direct writes to RPC-only tables ───────────────────────────────────
// Mirrors the cloud routine's known-exception list exactly (see CLAUDE.md /
// the routine's own prompt): a handful of call sites are deliberately not
// RPC-routed and shouldn't be flagged every day.
const RPC_TABLES     = ['sale_orders', 'so_lines', 'stock_moves', 'memberships'];
const WRITE_METHODS  = new Set(['insert', 'update', 'delete', 'upsert']);
const KNOWN_EXCEPTIONS = [
  { file: 'stores/products.ts',              table: 'stock_moves',  method: 'insert' },
  { file: 'app/(app)/parametres/index.tsx',  table: 'memberships',  method: 'delete' },
  { file: 'stores/equipe.ts',                table: 'memberships',  method: 'delete' },
  { file: 'stores/equipe.ts',                table: 'memberships',  method: 'update' },
];

function findRpcWriteViolations() {
  const tablesAlt = RPC_TABLES.join('|');
  let candidateFiles = [];
  try {
    candidateFiles = execSync(
      `grep -rl -E "\\.from\\((['\\"])(${tablesAlt})\\1\\)" app stores src` +
      ` --include="*.tsx" --include="*.ts" --exclude-dir=node_modules`,
      { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }
    ).trim().split('\n').filter(Boolean);
  } catch { return []; }

  const chainRe = /\.from\(\s*(['"])(sale_orders|so_lines|stock_moves|memberships)\1\s*\)\s*\.\s*([a-zA-Z]+)\s*\(/g;
  const violations = [];

  for (const rel of candidateFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    chainRe.lastIndex = 0;
    let m;
    while ((m = chainRe.exec(src))) {
      const table  = m[2];
      const method = m[3];
      if (!WRITE_METHODS.has(method)) continue;
      const excepted = KNOWN_EXCEPTIONS.some(
        e => e.file === rel && e.table === table && e.method === method
      );
      if (excepted) continue;
      const line = src.slice(0, m.index).split('\n').length;
      violations.push(`${rel}:${line} .from('${table}').${method}(`);
    }
  }
  return violations;
}
const rpcViolations = findRpcWriteViolations();

// ─── A4. Raw parseFloat usage (informational, not pass/fail) ───────────────
// Only a heuristic (real "is this money that skips parseAmountInput"
// judgment needs a human) — listed for manual review, never gates
// quality_ok. Excludes src/utils/format.ts itself (parseAmountInput's own
// implementation) and any line already calling parseAmountInput.
function findRawParseFloatLines() {
  let lines = [];
  try {
    lines = execSync(
      `grep -rn 'parseFloat(' app stores src --include="*.tsx" --include="*.ts" --exclude-dir=node_modules`,
      { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }
    ).trim().split('\n').filter(Boolean);
  } catch { return []; }
  return lines
    .filter(l => !l.startsWith('src/utils/format.ts:'))
    .filter(l => !/parseAmountInput/.test(l));
}
const parseFloatLines = findRawParseFloatLines();

// ─── B/C. Migrations — count, new this week, header summaries ──────────────
const dbDir = path.join(ROOT, 'db');
const allMigrations = fs.existsSync(dbDir)
  ? fs.readdirSync(dbDir)
      .filter(f => /^migration_v\d+/.test(f))
      .sort((a, b) => parseInt(a.match(/v(\d+)/)[1], 10) - parseInt(b.match(/v(\d+)/)[1], 10))
  : [];
const migrationCount = allMigrations.length;
const latestMigration = allMigrations[allMigrations.length - 1] || 'aucune';

let newMigrationsThisWeek = [];
try {
  newMigrationsThisWeek = execSync(
    `git log --since='7 days ago' --name-only --pretty=format: -- 'db/migration_v*.sql'`,
    { cwd: ROOT, encoding: 'utf-8' }
  ).split('\n').map(s => s.trim()).filter(Boolean);
  newMigrationsThisWeek = [...new Set(newMigrationsThisWeek)]
    .filter(f => /^db\/migration_v\d+/.test(f))
    .sort();
} catch {}

let recentDbCommits = [];
try {
  recentDbCommits = execSync(`git log --oneline -5 -- db/`, { cwd: ROOT, encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean);
} catch {}

// Migration files in this repo carry a rich descriptive header comment block
// (see CLAUDE.md's own migration table) — pulling that instead of trying to
// re-derive "does this drift from src/types/index.ts" heuristically gives a
// human something real to judge, rather than a script pretending to reason
// about it.
function migrationHeader(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return '(fichier introuvable)';
  const lines = fs.readFileSync(full, 'utf-8').split('\n');
  const headerLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) {
      const text = trimmed.replace(/^--+\s?/, '');
      if (text && !/^=+$/.test(text)) headerLines.push(text);
    } else if (trimmed === '') {
      if (headerLines.length) break;
    } else break;
  }
  return headerLines.join(' ') || '(pas de commentaire d\'en-tête)';
}

// ─── Assemble quality verdict ───────────────────────────────────────────────
const failing = [];
if (!tsOk) failing.push('TypeScript');
if (hexLines.length) failing.push('Hex codés en dur');
if (rpcViolations.length) failing.push('Écritures directes RPC');
const quality_ok = failing.length === 0;
const quality_issue_count = failing.length;

// ─── Build HTML row fragment (matches the relay's shared card styling) ─────
const GREEN = '#059669', RED = '#dc2626', AMBER = '#d97706', GRAY = '#9ca3af';
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`;

const divider = `<tr><td style="padding:8px 40px;"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0;"></td></tr>`;
function label(text) {
  return `<tr><td style="padding:20px 40px 8px 40px;font-size:11px;font-weight:600;letter-spacing:0.05em;color:${GRAY};text-transform:uppercase;font-family:${FONT};">${esc(text)}</td></tr>`;
}
function detailBlock(lines, color) {
  const shown = lines.slice(0, 12).map(esc).join('\n');
  const more  = lines.length > 12 ? `\n… et ${lines.length - 12} de plus` : '';
  return `<tr><td style="padding:4px 40px 10px;"><pre style="background:#f9fafb;border-left:3px solid ${color};border-radius:4px;padding:10px 12px;font-size:11px;line-height:1.5;overflow-x:auto;margin:0;white-space:pre-wrap;word-break:break-all;color:#374151;font-family:ui-monospace,monospace;">${shown}${esc(more)}</pre></td></tr>`;
}
function statusRow(rowLabel, ok, lines, opts = {}) {
  const failColor = opts.informational ? AMBER : RED;
  const okText    = opts.okText ?? '✓ OK';
  const statusHtml = ok
    ? `<span style="color:${GREEN};font-weight:600;">${okText}</span>`
    : `<span style="color:${failColor};font-weight:600;">${opts.informational ? '⚠' : '✗'} ${lines.length}</span>`;
  let out = `<tr><td style="padding:6px 40px;font-family:${FONT};font-size:13px;color:#374151;">
    <table width="100%"><tr><td>${esc(rowLabel)}</td><td align="right">${statusHtml}</td></tr></table>
  </td></tr>`;
  if (!ok && lines.length) out += detailBlock(lines, failColor);
  return out;
}
function plainRow(text, color) {
  return `<tr><td style="padding:6px 40px;font-family:${FONT};font-size:13px;color:${color || '#374151'};">${text}</td></tr>`;
}

let html = '';

// 1. QUALITÉ DU CODE
html += divider + label('QUALITÉ DU CODE');
html += statusRow('TypeScript', tsOk, tsLines);
html += statusRow('Couleurs hex codées en dur', hexLines.length === 0, hexLines);
html += statusRow('Écritures directes RPC', rpcViolations.length === 0, rpcViolations);
html += statusRow('parseFloat brut (revue manuelle)', parseFloatLines.length === 0, parseFloatLines, { informational: true });

// 2. DRIFT DB ↔ TS
html += divider + label('DRIFT DB ↔ TS');
if (newMigrationsThisWeek.length === 0) {
  html += plainRow(`<span style="color:${GREEN};">✓ Aucune migration cette semaine — rien à comparer.</span>`);
} else {
  html += plainRow(`<span style="color:${AMBER};">⚠ ${newMigrationsThisWeek.length} migration(s) cette semaine — vérifiez src/types/index.ts manuellement :</span>`);
  for (const f of newMigrationsThisWeek) {
    html += plainRow(`<b>${esc(path.basename(f))}</b> — ${esc(migrationHeader(f))}`);
  }
}

// 3. MIGRATIONS SUPABASE
html += divider + label('MIGRATIONS SUPABASE');
html += plainRow(`Total : <b>${migrationCount}</b> (v1 → ${esc(latestMigration.replace(/^migration_/, '').replace(/\.sql$/, ''))})`);
html += plainRow(`Nouvelles cette semaine : ${newMigrationsThisWeek.length ? esc(newMigrationsThisWeek.map(f => path.basename(f)).join(', ')) : 'Aucune'}`);
html += plainRow(`Derniers commits DB : ${recentDbCommits.length ? esc(recentDbCommits.join(' · ')) : '(aucun)'}`);
html += plainRow(`⚠ Vérifiez que toutes les migrations ont été appliquées dans le SQL Editor Supabase, dans l'ordre des versions.`, AMBER);

// 4. ANALYTICS (placeholder — no PostHog key wired into this workflow yet)
html += divider + label('ANALYTICS');
html += plainRow('Non disponible depuis ce canal — nécessite une clé API PostHog (voir CLAUDE.md).', GRAY);

// 5. APPAREILS (placeholder — same reason)
html += divider + label('APPAREILS');
html += plainRow('Données appareil non disponibles depuis ce canal.', GRAY);

// ─── Send (exactly once) ────────────────────────────────────────────────────
if (!RELAY_SECRET) {
  console.error('REPORT_RELAY_SECRET manquant — rapport non envoyé');
  process.exit(1);
}

const payload = JSON.stringify({
  include_reconciliation: true,
  quality_ok,
  quality_issue_count,
  html,
});

const req = https.request(
  {
    hostname: RELAY_HOST,
    path:     RELAY_PATH,
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'x-relay-secret': RELAY_SECRET,
      'Content-Length': Buffer.byteLength(payload),
    },
  },
  res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => {
      if (res.statusCode >= 400) {
        console.error('Relay error', res.statusCode, body);
        process.exit(1);
      }
      console.log(`✓ Rapport combiné envoyé (${res.statusCode}) — ${body}`);
    });
  }
);
req.on('error', err => { console.error(err); process.exit(1); });
req.write(payload);
req.end();
