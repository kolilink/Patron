// Who may walk away from a business, and what they must do first. Mirrors the
// server matrix in db/migration_v239.sql (leave_or_delete_business) so the app
// asks the right question BEFORE calling the RPC; the RPC stays the real gate.

export type LeavePlan = 'leave' | 'delete_business' | 'succession';

/**
 * - non-admin                                   → just leave
 * - administrateur, nobody else in the business → quitting IS deleting
 * - administrateur, others + ANOTHER administrateur → just leave
 * - administrateur, others, none of them an administrateur → succession first
 * `others` = every OTHER member's role. (A "manager" is labelled "Gérant" in the
 * UI but is not an administrateur: promoting one is the succession.)
 */
export function planLeave(role: string, others: { role: string }[]): LeavePlan {
  if (role !== 'administrateur') return 'leave';
  if (others.length === 0) return 'delete_business';
  if (others.some(o => o.role === 'administrateur')) return 'leave';
  return 'succession';
}

export interface AdminBusiness { business_id: string; name: string }

/** The administered businesses that need a successor before the account can be deleted. */
export function successionBlockers(
  administered: AdminBusiness[],
  othersByBusiness: Record<string, { role: string }[]>,
): AdminBusiness[] {
  return administered.filter(b => planLeave('administrateur', othersByBusiness[b.business_id] ?? []) === 'succession');
}

export const SUCCESSION_TITLE = 'Désignez un successeur';

export function successionBody(businessName: string): string {
  return `Vous êtes le seul gérant de ${businessName}. Choisissez qui reprend le commerce avant de quitter — vos vendeurs garderont leur accès.`;
}

export const ACCOUNT_DELETION_CANCELLED_TOAST = 'Bon retour — la suppression de votre compte a été annulée.';
