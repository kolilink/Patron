import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  runReconciliation,
  renderReconciliationSection,
  type ReconciliationRun,
  type ReconciliationFinding,
  type CurrencySnapshot,
} from '../_shared/reconciliation.ts';

// Standalone nightly reconciliation email. As of the daily combined report
// (send-report-email with include_reconciliation:true), the pg_cron trigger
// for this function has been unscheduled — the 6am combined email is now the
// only one the founder receives automatically. This function is kept as-is
// for manual/debug invocation (e.g. re-running a check after a fix).

function buildEmail(run: ReconciliationRun, findings: ReconciliationFinding[], snapshot: CurrencySnapshot[]): string {
  const date = new Date(run.started_at).toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const durationMs = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
  const durationSec = (durationMs / 1000).toFixed(1);

  const isClean = run.status === 'clean';
  const headerBg = isClean ? '#059669' : run.critical_count > 0 ? '#dc2626' : '#d97706';
  const headerText = isClean
    ? '✅ Tout est propre — 78 vérifications OK'
    : run.critical_count > 0
      ? `🚨 ${run.critical_count} critique(s) · ${run.warning_count} alerte(s)`
      : `⚠️ ${run.warning_count} alerte(s) — aucun critique`;

  return `<!DOCTYPE html>
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
             color:rgba(255,255,255,0.75);text-transform:uppercase;">Patron · Réconciliation</p>
          <p style="margin:8px 0 0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;">
            ${headerText}
          </p>
          <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,0.8);">
            ${date} · ${durationSec}s d'exécution
          </p>
        </td></tr>

        ${renderReconciliationSection(run, findings, snapshot)}

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
            Patron · Réconciliation automatique (manuelle) · Le rapport quotidien 6h ET l'inclut désormais aussi
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Handler ─────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Verify this is a legitimate cron call. Fail closed: an unset CRON_SECRET
  // must reject the request, not skip the check — this endpoint runs with
  // the service role and can read every business's financial data.
  const cronSecret = Deno.env.get('CRON_SECRET');
  const incoming = req.headers.get('x-cron-secret');
  if (!cronSecret || incoming !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Non autorisé' }), { status: 401 });
  }

  try {
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { run, findings, snapshot } = await runReconciliation(serviceClient);

    // Send email via Resend
    const founderEmail = Deno.env.get('FOUNDER_EMAIL') ?? 'mdousebastiao@gmail.com';
    const resendKey = Deno.env.get('RESEND_API_KEY')!;

    const date = new Date(run.started_at).toLocaleDateString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });

    const subject = run.status === 'clean'
      ? `[Patron] ✅ Réconciliation du ${date} — tout est propre`
      : run.critical_count > 0
        ? `[Patron] 🚨 ${run.critical_count} critique(s) détecté(s) — ${date}`
        : `[Patron] ⚠️ ${run.warning_count} alerte(s) — ${date}`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Patron <noreply@patron.kolilink.com>',
        to: [founderEmail],
        subject,
        html: buildEmail(run, findings, snapshot),
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.json().catch(() => ({})) as { message?: string };
      throw new Error(`Resend failed: ${errBody.message ?? emailRes.statusText}`);
    }

    return new Response(
      JSON.stringify({
        run_id: run.id,
        status: run.status,
        critical_count: run.critical_count,
        warning_count: run.warning_count,
        businesses_checked: run.businesses_checked,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('send-reconciliation-report crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
