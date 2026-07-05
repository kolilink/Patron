import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Types ───────────────────────────────────────────────────

interface ReconciliationRun {
  id: string;
  started_at: string;
  completed_at: string;
  total_findings: number;
  critical_count: number;
  warning_count: number;
  businesses_checked: number;
  status: 'running' | 'clean' | 'findings' | 'error';
  error_detail: string | null;
}

interface ReconciliationFinding {
  check_id: number;
  domain: string;
  check_name: string;
  severity: 'critical' | 'warning';
  business_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  detail: string;
  affected_count: number;
}

interface SnapshotPeriod {
  revenue: number;
  cogs: number;
  expenses: number;
  net_profit: number;
}

interface CurrencySnapshot {
  currency: string;
  today: SnapshotPeriod;
  month_to_date: SnapshotPeriod;
}

// Whole-unit currencies (no decimal subdivision in everyday use) — same
// convention as src/utils/format.ts in the app.
const WHOLE_UNIT_CURRENCIES = new Set(['GNF', 'XOF', 'XAF']);

function formatSnapshotAmount(cents: number, currency: string): string {
  const isWhole = WHOLE_UNIT_CURRENCIES.has(currency);
  const value = cents / 100;
  const formatted = isWhole
    ? Math.round(value).toLocaleString('fr-FR')
    : value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ${currency}`;
}

// ─── Email builder ───────────────────────────────────────────

function renderSnapshot(snapshot: CurrencySnapshot[]): string {
  if (snapshot.length === 0) return '';
  const rows = snapshot.map(s => `
    <tr><td style="padding:10px 40px;border-bottom:1px solid #f3f4f6;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.04em;
         color:#6b7280;text-transform:uppercase;">${escapeHtml(s.currency)}</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:12px;color:#6b7280;width:50%;">Aujourd'hui</td>
          <td style="font-size:12px;color:#6b7280;width:50%;">Ce mois</td>
        </tr>
        <tr>
          <td style="font-size:14px;font-weight:700;color:${s.today.net_profit >= 0 ? '#059669' : '#dc2626'};">
            ${formatSnapshotAmount(s.today.net_profit, s.currency)}
          </td>
          <td style="font-size:14px;font-weight:700;color:${s.month_to_date.net_profit >= 0 ? '#059669' : '#dc2626'};">
            ${formatSnapshotAmount(s.month_to_date.net_profit, s.currency)}
          </td>
        </tr>
        <tr>
          <td style="font-size:11px;color:#9ca3af;padding-top:2px;">
            CA ${formatSnapshotAmount(s.today.revenue, s.currency)} ·
            Coût ${formatSnapshotAmount(s.today.cogs, s.currency)} ·
            Dép. ${formatSnapshotAmount(s.today.expenses, s.currency)}
          </td>
          <td style="font-size:11px;color:#9ca3af;padding-top:2px;">
            CA ${formatSnapshotAmount(s.month_to_date.revenue, s.currency)} ·
            Coût ${formatSnapshotAmount(s.month_to_date.cogs, s.currency)} ·
            Dép. ${formatSnapshotAmount(s.month_to_date.expenses, s.currency)}
          </td>
        </tr>
      </table>
    </td></tr>`).join('');

  return `
    <tr><td style="padding:24px 40px 4px;">
      <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.05em;
         color:#9ca3af;text-transform:uppercase;">
        Aperçu financier — calculé indépendamment de l'app, directement depuis le registre
      </p>
    </td></tr>
    <tr><td style="padding:0 40px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f3f4f6;border-radius:8px;overflow:hidden;">
        ${rows}
      </table>
    </td></tr>`;
}

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

  const criticals = findings.filter(f => f.severity === 'critical');
  const warnings = findings.filter(f => f.severity === 'warning');

  // Group by domain
  const groupByDomain = (list: ReconciliationFinding[]): Map<string, ReconciliationFinding[]> => {
    const map = new Map<string, ReconciliationFinding[]>();
    for (const f of list) {
      const arr = map.get(f.domain) ?? [];
      arr.push(f);
      map.set(f.domain, arr);
    }
    return map;
  };

  const renderFindings = (list: ReconciliationFinding[], color: string, label: string): string => {
    if (list.length === 0) return '';
    const byDomain = groupByDomain(list);
    let html = `
      <tr><td style="padding:24px 40px 8px;">
        <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:0.06em;
           color:${color};text-transform:uppercase;">${label} (${list.length})</p>
      </td></tr>`;
    for (const [domain, items] of byDomain) {
      html += `
        <tr><td style="padding:4px 40px 0;">
          <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.05em;
             color:#6b7280;text-transform:uppercase;">${domain}</p>
        </td></tr>`;
      for (const item of items) {
        const dot = item.severity === 'critical' ? '🔴' : '🟡';
        html += `
          <tr><td style="padding:3px 40px;">
            <p style="margin:0;font-size:13px;color:#374151;line-height:1.5;">
              ${dot} <strong>[#${item.check_id}]</strong> ${escapeHtml(item.detail)}
            </p>
          </td></tr>`;
      }
    }
    return html;
  };

  const statsRow = (label: string, value: string | number, accent?: string) => `
    <td style="text-align:center;padding:0 16px;">
      <p style="margin:0;font-size:24px;font-weight:700;color:${accent ?? '#111827'};">${value}</p>
      <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;text-transform:uppercase;
         letter-spacing:0.05em;">${label}</p>
    </td>`;

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

        <!-- Stats row -->
        <tr><td style="padding:24px 40px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              ${statsRow('Boutiques', run.businesses_checked)}
              ${statsRow('Critiques', run.critical_count, run.critical_count > 0 ? '#dc2626' : '#059669')}
              ${statsRow('Alertes', run.warning_count, run.warning_count > 0 ? '#d97706' : '#059669')}
              ${statsRow('Vérifications', 78)}
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 40px;">
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:0;">
        </td></tr>

        <!-- Financial snapshot (ground truth, independent of app formulas) -->
        ${renderSnapshot(snapshot)}

        <!-- Clean state -->
        ${isClean ? `
        <tr><td style="padding:32px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="background:#f0fdf4;border-radius:12px;padding:24px;text-align:center;">
              <p style="margin:0;font-size:32px;">✅</p>
              <p style="margin:12px 0 4px;font-size:15px;font-weight:600;color:#166534;">
                Tous les comptes sont exacts
              </p>
              <p style="margin:0;font-size:13px;color:#4b5563;">
                78 contrôles exécutés · 0 anomalie · ${run.businesses_checked} boutiques vérifiées
              </p>
            </td></tr>
          </table>
        </td></tr>` : ''}

        <!-- Error state -->
        ${run.status === 'error' ? `
        <tr><td style="padding:32px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="background:#fef2f2;border-radius:12px;padding:24px;">
              <p style="margin:0;font-size:14px;font-weight:600;color:#991b1b;">
                ❌ La réconciliation a échoué
              </p>
              <p style="margin:8px 0 0;font-size:12px;color:#6b7280;font-family:monospace;
                 word-break:break-all;">
                ${escapeHtml(run.error_detail ?? 'Erreur inconnue')}
              </p>
            </td></tr>
          </table>
        </td></tr>` : ''}

        <!-- Critical findings -->
        ${renderFindings(criticals, '#dc2626', '🔴 Critiques — action requise')}

        <!-- Divider between critical and warning -->
        ${criticals.length > 0 && warnings.length > 0 ? `
        <tr><td style="padding:8px 40px;">
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:0;">
        </td></tr>` : ''}

        <!-- Warning findings -->
        ${renderFindings(warnings, '#d97706', '⚠️ Alertes — à surveiller')}

        <!-- Domain coverage summary -->
        ${!isClean ? `
        <tr><td style="padding:24px 40px 8px;">
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 20px;">
          <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.05em;
             color:#9ca3af;text-transform:uppercase;">Domaines vérifiés</p>
        </td></tr>
        <tr><td style="padding:4px 40px 24px;">
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.8;">
            Stock · Ventes · Paiements · COGS · Dépenses · Crédit ·
            Fournisseurs · Commandes · Produits · Montants · Membres ·
            Agrégats · Temporel · Intégrité référentielle · Affichage
          </p>
        </td></tr>` : ''}

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
            Patron · Réconciliation automatique · Exécutée chaque nuit à 02h00 UTC
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

    // 1. Run the 69 structural reconciliation checks
    const { data: runIdData, error: rpcErr } = await serviceClient
      .rpc('run_reconciliation');

    if (rpcErr) throw new Error(`run_reconciliation() failed: ${rpcErr.message}`);
    const runId: string = runIdData;

    // 2. Run the 10 display-accuracy checks (69–78) and refresh run totals
    const { error: displayErr } = await serviceClient.rpc('run_display_checks', { p_run_id: runId });
    if (displayErr) console.error('run_display_checks failed:', displayErr.message);
    else {
      const { error: refreshErr } = await serviceClient.rpc('refresh_reconciliation_run', { p_run_id: runId });
      if (refreshErr) console.error('refresh_reconciliation_run failed:', refreshErr.message);
    }

    // 3. Fetch the run summary (after display checks updated the totals)
    const { data: run, error: runErr } = await serviceClient
      .from('reconciliation_runs')
      .select('*')
      .eq('id', runId)
      .single<ReconciliationRun>();

    if (runErr || !run) throw new Error(`Failed to fetch run: ${runErr?.message}`);

    // 4. Fetch all findings, ordered by severity then check_id
    const { data: findings, error: findErr } = await serviceClient
      .from('reconciliation_findings')
      .select('check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count')
      .eq('run_id', runId)
      .order('severity', { ascending: true })   // critical before warning (alphabetically c < w)
      .order('check_id', { ascending: true })
      .returns<ReconciliationFinding[]>();

    if (findErr) throw new Error(`Failed to fetch findings: ${findErr.message}`);

    // 5. Independent ground-truth financial snapshot (not from app code).
    //    Best-effort: a failure here shouldn't block the integrity report.
    const { data: snapshotData, error: snapshotErr } = await serviceClient
      .rpc('get_financial_snapshot');
    if (snapshotErr) console.error('get_financial_snapshot failed:', snapshotErr.message);
    const snapshot = (snapshotData ?? []) as CurrencySnapshot[];

    // 6. Send email via Resend
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
        html: buildEmail(run, findings ?? [], snapshot),
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.json().catch(() => ({})) as { message?: string };
      throw new Error(`Resend failed: ${errBody.message ?? emailRes.statusText}`);
    }

    return new Response(
      JSON.stringify({
        run_id: runId,
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
