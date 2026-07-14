import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runReconciliation, renderReconciliationSection } from '../_shared/reconciliation.ts';

// Generic email relay for scheduled reporting agents (Claude Code routines)
// that have no Gmail "send" capability, only "create draft". Those routines
// POST here instead of going through Gmail MCP, so reports actually land in
// the inbox instead of piling up as unsent drafts.
//
// Auth: shared secret header, same pattern as send-reconciliation-report.
// Always sends to FOUNDER_EMAIL — this is intentionally not an open relay,
// it only ever delivers to the founder's own inbox.
//
// When include_reconciliation is true (used by the daily 6am combined
// report), this function also runs the 78-check reconciliation + financial
// snapshot itself (service-role DB access, same as send-reconciliation-report)
// and renders it as the top section of the email, above the caller's own
// `html` section — so the founder gets exactly ONE email per day instead of
// a separate reconciliation email plus a separate quality-check draft.

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const relaySecret = Deno.env.get('REPORT_RELAY_SECRET');
  const incoming = req.headers.get('x-relay-secret');
  if (!relaySecret || incoming !== relaySecret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: {
    subject?: string;
    html?: string;
    text?: string;
    include_reconciliation?: boolean;
    quality_ok?: boolean;
    quality_issue_count?: number;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { subject, html, text, include_reconciliation, quality_ok, quality_issue_count } = body;
  if (!include_reconciliation && !subject) {
    return new Response(
      JSON.stringify({ error: 'subject is required unless include_reconciliation is true' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (!html && !text) {
    return new Response(
      JSON.stringify({ error: 'html or text is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const founderEmail = Deno.env.get('FOUNDER_EMAIL') ?? 'mdousebastiao@gmail.com';
  const resendKey = Deno.env.get('RESEND_API_KEY')!;

  let finalSubject = subject ?? '';
  let finalHtml = html ?? `<pre>${text}</pre>`;

  if (include_reconciliation) {
    try {
      const serviceClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      const { run, findings, snapshot } = await runReconciliation(serviceClient);

      const dateFr = new Date(run.started_at).toLocaleDateString('fr-FR', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
      const dateShort = new Date(run.started_at).toLocaleDateString('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
      });

      const qualityIssues = quality_ok === false ? (quality_issue_count ?? 1) : 0;
      const isFullyClean = run.status === 'clean' && qualityIssues === 0;

      const headerBg = isFullyClean
        ? '#059669'
        : run.critical_count > 0
          ? '#dc2626'
          : (run.warning_count > 0 || qualityIssues > 0)
            ? '#d97706'
            : '#059669';

      const headerParts: string[] = [];
      if (run.critical_count > 0) headerParts.push(`🚨 ${run.critical_count} critique(s)`);
      if (run.warning_count > 0) headerParts.push(`${run.critical_count > 0 ? '' : '⚠️ '}${run.warning_count} alerte(s)`);
      if (qualityIssues > 0) headerParts.push(`${qualityIssues} pb qualité`);
      const headerText = isFullyClean
        ? '✅ Tout est sain — comptes exacts, code propre'
        : headerParts.join(' · ');

      finalSubject = isFullyClean
        ? `Patron ✓ Rapport du ${dateShort}`
        : `Patron ${run.critical_count > 0 ? '🚨' : '⚠️'} ${headerParts.join(', ')} — ${dateShort}`;

      finalHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0"
        style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;
               box-shadow:0 1px 3px rgba(0,0,0,0.1);">

        <!-- Header -->
        <tr><td style="background:${headerBg};padding:32px 40px;">
          <p style="margin:0;font-size:12px;font-weight:600;letter-spacing:0.08em;
             color:rgba(255,255,255,0.75);text-transform:uppercase;">Patron · Rapport quotidien · 6h00 ET</p>
          <p style="margin:8px 0 0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;">
            ${headerText}
          </p>
          <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,0.8);">
            ${escapeHtml(dateFr)}
          </p>
        </td></tr>

        <!-- Reconciliation section (ground truth, checked first) -->
        ${renderReconciliationSection(run, findings, snapshot)}

        <!-- Divider between reconciliation and quality/analytics section -->
        <tr><td style="padding:8px 40px;">
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:0;">
        </td></tr>

        <!-- Caller's own section (code quality, drift, migrations, analytics, devices) -->
        ${finalHtml}

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
            Patron · Rapport quotidien combiné · Généré automatiquement
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur inconnue';
      console.error('include_reconciliation failed:', msg);
      // Fail open on the reconciliation half — still deliver the caller's own
      // report rather than losing the whole email over one RPC hiccup.
      finalSubject = subject ?? `Patron — Rapport quotidien (réconciliation indisponible)`;
      finalHtml = `<p style="font-family:-apple-system,sans-serif;color:#dc2626;">
        ⚠️ La section réconciliation n'a pas pu être générée : ${escapeHtml(msg)}
      </p>${html ?? `<pre>${text}</pre>`}`;
    }
  }

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Patron <noreply@patron.kolilink.com>',
      to: [founderEmail],
      subject: finalSubject,
      html: finalHtml,
    }),
  });

  if (!emailRes.ok) {
    const detail = await emailRes.text();
    return new Response(JSON.stringify({ error: 'resend_failed', detail }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const result = await emailRes.json();
  return new Response(JSON.stringify({ status: 'sent', id: result.id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
