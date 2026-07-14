import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Shared between send-reconciliation-report (nightly, standalone) and
// send-report-email (daily combined report) so the 78-check reconciliation
// run + financial snapshot logic lives in exactly one place.

export interface ReconciliationRun {
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

export interface ReconciliationFinding {
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

export interface SnapshotPeriod {
  revenue: number;
  cogs: number;
  expenses: number;
  net_profit: number;
}

export interface CurrencySnapshot {
  currency: string;
  today: SnapshotPeriod;
  month_to_date: SnapshotPeriod;
}

// Whole-unit currencies (no decimal subdivision in everyday use) — same
// convention as src/utils/format.ts in the app.
const WHOLE_UNIT_CURRENCIES = new Set(['GNF', 'XOF', 'XAF']);

export function formatSnapshotAmount(cents: number, currency: string): string {
  const isWhole = WHOLE_UNIT_CURRENCIES.has(currency);
  const value = cents / 100;
  const formatted = isWhole
    ? Math.round(value).toLocaleString('fr-FR')
    : value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ${currency}`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Runs the 68 structural checks + 10 display checks, refreshes totals, and
// fetches the run/findings/financial snapshot. Requires a service-role client.
export async function runReconciliation(serviceClient: SupabaseClient): Promise<{
  run: ReconciliationRun;
  findings: ReconciliationFinding[];
  snapshot: CurrencySnapshot[];
}> {
  const { data: runIdData, error: rpcErr } = await serviceClient.rpc('run_reconciliation');
  if (rpcErr) throw new Error(`run_reconciliation() failed: ${rpcErr.message}`);
  const runId: string = runIdData;

  const { error: displayErr } = await serviceClient.rpc('run_display_checks', { p_run_id: runId });
  if (displayErr) console.error('run_display_checks failed:', displayErr.message);
  else {
    const { error: refreshErr } = await serviceClient.rpc('refresh_reconciliation_run', { p_run_id: runId });
    if (refreshErr) console.error('refresh_reconciliation_run failed:', refreshErr.message);
  }

  const { data: run, error: runErr } = await serviceClient
    .from('reconciliation_runs')
    .select('*')
    .eq('id', runId)
    .single<ReconciliationRun>();
  if (runErr || !run) throw new Error(`Failed to fetch run: ${runErr?.message}`);

  const { data: findings, error: findErr } = await serviceClient
    .from('reconciliation_findings')
    .select('check_id,domain,check_name,severity,business_id,entity_type,entity_id,detail,affected_count')
    .eq('run_id', runId)
    .order('severity', { ascending: true })
    .order('check_id', { ascending: true })
    .returns<ReconciliationFinding[]>();
  if (findErr) throw new Error(`Failed to fetch findings: ${findErr.message}`);

  const { data: snapshotData, error: snapshotErr } = await serviceClient.rpc('get_financial_snapshot');
  if (snapshotErr) console.error('get_financial_snapshot failed:', snapshotErr.message);
  const snapshot = (snapshotData ?? []) as CurrencySnapshot[];

  return { run, findings: findings ?? [], snapshot };
}

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

function groupByDomain(list: ReconciliationFinding[]): Map<string, ReconciliationFinding[]> {
  const map = new Map<string, ReconciliationFinding[]>();
  for (const f of list) {
    const arr = map.get(f.domain) ?? [];
    arr.push(f);
    map.set(f.domain, arr);
  }
  return map;
}

function renderFindings(list: ReconciliationFinding[], color: string, label: string): string {
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
}

// Renders the reconciliation portion as a set of <tr> rows meant to be
// embedded inside a shared outer <table> card — no <html>/<body>/outer
// wrapper here, so callers can stack this above their own sections.
export function renderReconciliationSection(
  run: ReconciliationRun,
  findings: ReconciliationFinding[],
  snapshot: CurrencySnapshot[],
): string {
  const isClean = run.status === 'clean';
  const criticals = findings.filter(f => f.severity === 'critical');
  const warnings = findings.filter(f => f.severity === 'warning');

  const statsRow = (label: string, value: string | number, accent?: string) => `
    <td style="text-align:center;padding:0 16px;">
      <p style="margin:0;font-size:24px;font-weight:700;color:${accent ?? '#111827'};">${value}</p>
      <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;text-transform:uppercase;
         letter-spacing:0.05em;">${label}</p>
    </td>`;

  return `
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

    ${renderSnapshot(snapshot)}

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

    ${renderFindings(criticals, '#dc2626', '🔴 Critiques — action requise')}

    ${criticals.length > 0 && warnings.length > 0 ? `
    <tr><td style="padding:8px 40px;">
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:0;">
    </td></tr>` : ''}

    ${renderFindings(warnings, '#d97706', '⚠️ Alertes — à surveiller')}

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
    </td></tr>` : ''}`;
}
