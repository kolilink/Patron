// Shared by clients/index.tsx (list) and clients/[name].tsx (detail) so the
// Recouvrement flow's copy and color escalation can't quietly drift between
// the two screens.

// "Depuis aujourd'hui" / "Depuis N jours" / "Depuis N mois" past 60 days.
// Never negative — callers are expected to have already clamped `days` to
// >= 0 (see the getDaysAgo/debtAge fixes this shipped alongside), but this
// floors defensively too rather than trust that.
export function formatDebtAge(days: number): string {
  const d = Math.max(0, days);
  if (d === 0) return "Depuis aujourd'hui";
  if (d === 1) return 'Depuis 1 jour';
  if (d < 60) return `Depuis ${d} jours`;
  const months = Math.round(d / 30);
  return `Depuis ${months} mois`;
}

// Color escalates with AGE, never with the amount itself — a big debt owed
// since yesterday isn't more alarming than a small one owed for two months.
// Returns a tier name, not a color, since this file has no theme context;
// callers map it to their own palette.recouvrementPending/Owed tokens.
export type DebtAgeTier = 'normal' | 'attention' | 'urgent';
export function debtAgeTier(days: number): DebtAgeTier {
  if (days >= 30) return 'urgent';
  if (days >= 7) return 'attention';
  return 'normal';
}

// Takes an already-formatted amount string, not a raw number — each call
// site already has its own `fmt()` helper and this avoids introducing a
// second, possibly-diverging formatting path just for this message.
export function buildDebtReminderMessage(name: string, totalOwedFormatted: string): string {
  return [
    `Bonjour ${name},`,
    `Un petit point sur le carnet : il vous reste un solde de *${totalOwedFormatted}*.`,
    `Vous pouvez passer au commerce ou effectuer un dépôt directement.`,
    `Bonne journée à vous !`,
  ].join('\n');
}
