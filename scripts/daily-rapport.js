#!/usr/bin/env node
'use strict';

const { spawnSync, execSync } = require('child_process');
const https = require('https');
const fs   = require('fs');
const path = require('path');

const RESEND_KEY = process.env.RESEND_API_KEY;
const TO         = process.env.RECIPIENT_EMAIL || 'mdousebastiao@gmail.com';
const ROOT       = process.cwd();
const TODAY      = new Date().toISOString().split('T')[0];

// ─── 1. TypeScript ─────────────────────────────────────────────────────────────
const tsc     = spawnSync('npx', ['tsc', '--noEmit'], { cwd: ROOT, encoding: 'utf-8' });
const tsOk    = tsc.status === 0;
const tsLines = (tsc.stdout + tsc.stderr).trim().split('\n').filter(Boolean);

// ─── 2. Hardcoded hex colours ──────────────────────────────────────────────────
// Exclude theme/colors files — those are allowed to define hex.
function grep(pattern, dirs, extraFlags = '') {
  try {
    return execSync(
      `grep -rn ${extraFlags} '${pattern}' ${dirs.join(' ')}` +
      ` --include="*.tsx" --include="*.ts"` +
      ` --exclude-dir=node_modules` +
      ` --exclude="colors.ts" --exclude="palette*.ts" --exclude="index.ts"`,
      { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }
    ).trim().split('\n').filter(Boolean);
  } catch { return []; }
}
const hexLines    = grep('#[0-9A-Fa-f]\\{3,8\\}', ['app', 'src', 'stores']);

// ─── 3. SafeAreaView used as screen root (Screen component violation) ──────────
// Filter out lines inside Modal blocks and comments.
const svLines = grep('SafeAreaView', ['app'])
  .filter(l => !l.includes('Modal') && !l.includes('//') && !l.match(/^\s*\*/));

// ─── 4. Migration count ────────────────────────────────────────────────────────
const dbDir         = path.join(ROOT, 'db');
const migrationCount = fs.existsSync(dbDir)
  ? fs.readdirSync(dbDir).filter(f => /^migration_v\d+/.test(f)).length
  : 0;

// ─── 5. Recent commits ─────────────────────────────────────────────────────────
let commits = [];
try {
  commits = execSync('git log --oneline -8', { cwd: ROOT, encoding: 'utf-8' }).trim().split('\n');
} catch {}

// ─── 6. Assemble issues list ───────────────────────────────────────────────────
const issues = [];
if (!tsOk)          issues.push({ label: 'TypeScript',                      count: tsLines.length,  lines: tsLines.slice(0, 12)  });
if (hexLines.length) issues.push({ label: 'Hex codés en dur',               count: hexLines.length, lines: hexLines.slice(0, 12) });
if (svLines.length)  issues.push({ label: 'SafeAreaView (violation Screen)', count: svLines.length,  lines: svLines.slice(0, 12)  });

// ─── 7. Build HTML ─────────────────────────────────────────────────────────────
const clean       = issues.length === 0;
const statusColor = clean ? '#16a34a' : '#d97706';
const statusLabel = clean ? '✓ Tout est propre' : `✗ ${issues.length} problème(s)`;

function issueBlock(iss) {
  const more = iss.count > 12 ? `\n… et ${iss.count - 12} de plus` : '';
  return `
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:6px;">
        ${iss.label}
        <span style="color:#d97706;font-weight:400;"> — ${iss.count} occurrence(s)</span>
      </div>
      <pre style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;font-size:11px;line-height:1.5;overflow-x:auto;margin:0;white-space:pre-wrap;word-break:break-all;">${esc(iss.lines.join('\n'))}${esc(more)}</pre>
    </div>`;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const commitsHtml = commits
  .map(c => `<li style="font-size:12px;color:#374151;padding:3px 0;font-family:monospace;">${esc(c)}</li>`)
  .join('');

const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px 16px;">
  <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">

    <!-- Header -->
    <div style="background:#1e1b4b;padding:24px 28px;">
      <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-.3px;">Patron</div>
      <div style="font-size:13px;color:#a5b4fc;margin-top:3px;">Rapport quotidien · ${TODAY}</div>
    </div>

    <!-- Status -->
    <div style="padding:24px 28px 0;">
      <div style="font-size:28px;font-weight:700;color:${statusColor};margin-bottom:20px;">${statusLabel}</div>

      ${issues.length ? issues.map(issueBlock).join('') : `<p style="color:#16a34a;font-size:14px;margin:0 0 20px;">Aucune anomalie détectée aujourd'hui.</p>`}
    </div>

    <!-- KPI strip -->
    <div style="padding:0 28px 24px;display:flex;gap:12px;">
      <div style="flex:1;background:#f9fafb;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">TypeScript</div>
        <div style="font-size:20px;font-weight:700;color:${tsOk ? '#16a34a' : '#d97706'};">${tsOk ? 'OK' : tsLines.length + ' err'}</div>
      </div>
      <div style="flex:1;background:#f9fafb;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Hex codés</div>
        <div style="font-size:20px;font-weight:700;color:${hexLines.length ? '#d97706' : '#16a34a'};">${hexLines.length}</div>
      </div>
      <div style="flex:1;background:#f9fafb;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Migrations</div>
        <div style="font-size:20px;font-weight:700;color:#1e1b4b;">${migrationCount}</div>
      </div>
      <div style="flex:1;background:#f9fafb;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Screen ⚠</div>
        <div style="font-size:20px;font-weight:700;color:${svLines.length ? '#d97706' : '#16a34a'};">${svLines.length}</div>
      </div>
    </div>

    <!-- Commits -->
    <div style="padding:0 28px 24px;">
      <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Commits récents</div>
      <ul style="margin:0;padding:0 0 0 16px;">${commitsHtml}</ul>
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;padding:14px 28px;text-align:center;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;">
      Patron Quality Check · Généré automatiquement · 6h00 ET
    </div>
  </div>
</body>
</html>`;

// ─── 8. Send via Resend ────────────────────────────────────────────────────────
if (!RESEND_KEY) {
  console.error('RESEND_API_KEY manquant — email non envoyé');
  process.exit(1);
}

const subject = clean
  ? `Patron ✓ Tout est propre — ${TODAY}`
  : `Patron ✗ ${issues.length} problème(s) — ${TODAY}`;

const payload = JSON.stringify({
  from:    'Patron <noreply@patron.kolilink.com>',
  to:      [TO],
  subject,
  html,
});

const req = https.request(
  {
    hostname: 'api.resend.com',
    path:     '/emails',
    method:   'POST',
    headers:  {
      Authorization:   `Bearer ${RESEND_KEY}`,
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  },
  res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => {
      if (res.statusCode >= 400) {
        console.error('Resend error', res.statusCode, body);
        process.exit(1);
      }
      console.log(`✓ Email envoyé (${res.statusCode}) — ${subject}`);
    });
  }
);
req.on('error', err => { console.error(err); process.exit(1); });
req.write(payload);
req.end();
