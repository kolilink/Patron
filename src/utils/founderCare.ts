// Founder care plan J0 → J30 for the Vendeurs screen. Pure: the data comes
// from get_founder_vendor_directory() + get_founder_care_state()
// (db/migration_v246.sql). Nothing here sends anything — the founder taps a
// row, reads the prepared WhatsApp message, and sends it himself.

import type { DirectoryRow } from './founderDirectory';

export type CareStep = 'j0' | 'j1' | 'j7' | 'repos' | 'j30';

export const CARE_STEP_ORDER: CareStep[] = ['j0', 'j1', 'j7', 'repos', 'j30'];

export const CARE_STEP_LABEL: Record<CareStep, string> = {
  j0: 'Jour 0',
  j1: 'Jour 1',
  j7: 'Jour 7',
  repos: 'Repos',
  j30: 'Jour 30',
};

export interface CareContact {
  step: CareStep;
  contacted_at: string;
}

/** One row of get_founder_care_state(). */
export interface CareStateRow {
  business_id: string;
  sales_7d: number;
  credits_7d: number;
  contacts: CareContact[];
}

export interface CareMessageContext {
  number: number;
  total: number;
  sales7d: number;
  credits7d: number;
}

const DAY_MS = 86400000;

function contactedAt(contacts: CareContact[], step: CareStep): number | null {
  const c = contacts.find(x => x.step === step);
  return c ? new Date(c.contacted_at).getTime() : null;
}

/** Rank of a business by creation date (1 = first), over the FULL real list. */
export function shopNumber(rows: DirectoryRow[], businessId: string): number {
  const sorted = [...rows].sort((a, b) => {
    const d = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (d !== 0) return d;
    return a.business_id < b.business_id ? -1 : a.business_id > b.business_id ? 1 : 0;
  });
  const i = sorted.findIndex(r => r.business_id === businessId);
  return i === -1 ? 0 : i + 1;
}

/**
 * The step the founder owes this vendor right now, or null. Strict chain:
 * each step needs the previous one contacted, and after `repos` or `j30` is
 * contacted nothing is ever due again.
 */
export function dueStep(row: DirectoryRow, contacts: CareContact[], now: number = Date.now()): CareStep | null {
  if (contactedAt(contacts, 'repos') !== null || contactedAt(contacts, 'j30') !== null) return null;

  const age = now - new Date(row.created_at).getTime();
  if (contactedAt(contacts, 'j0') === null) return 'j0';
  if (age >= DAY_MS && contactedAt(contacts, 'j1') === null) return 'j1';
  if (age >= 7 * DAY_MS && contactedAt(contacts, 'j7') === null) return 'j7';

  const j7At = contactedAt(contacts, 'j7');
  if (j7At === null) return null; // j1 done but too young for j7, or j0 done and too young for j1
  const lastAction = row.last_action_at ? new Date(row.last_action_at).getTime() : null;
  const quietSinceJ7 = lastAction === null || lastAction <= j7At;
  if (now - j7At >= 7 * DAY_MS && quietSinceJ7) return 'repos';
  if (age >= 30 * DAY_MS) return 'j30';
  return null;
}

/** Number of vendors with a step due. */
export function todayCount(
  rows: DirectoryRow[],
  contactsByBusiness: Record<string, CareContact[]>,
  now: number = Date.now(),
): number {
  return rows.filter(r => dueStep(r, contactsByBusiness[r.business_id] ?? [], now) !== null).length;
}

/** Vendors with a step due, ordered by step then oldest first. */
export function contactRows(
  rows: DirectoryRow[],
  contactsByBusiness: Record<string, CareContact[]>,
  now: number = Date.now(),
): { row: DirectoryRow; step: CareStep }[] {
  const due: { row: DirectoryRow; step: CareStep }[] = [];
  for (const row of rows) {
    const step = dueStep(row, contactsByBusiness[row.business_id] ?? [], now);
    if (step) due.push({ row, step });
  }
  return due.sort((a, b) => {
    const s = CARE_STEP_ORDER.indexOf(a.step) - CARE_STEP_ORDER.indexOf(b.step);
    if (s !== 0) return s;
    return new Date(a.row.created_at).getTime() - new Date(b.row.created_at).getTime();
  });
}

function firstName(row: DirectoryRow): string {
  return (row.owner_name ?? '').trim().split(/\s+/)[0] ?? '';
}

/** The exact WhatsApp text for a step. "vous" everywhere, blocks split by a blank line. */
export function careMessage(step: CareStep, row: DirectoryRow, ctx: CareMessageContext): string {
  const who = firstName(row);
  const hello = who ? `Bonjour ${who}.` : 'Bonjour.';
  const n = ctx.number;
  const blocks: string[] = [];

  switch (step) {
    case 'j0': {
      const shopLine = who
        ? `Votre commerce porte le numéro ${n}.`
        : row.business_name
          ? `Votre boutique « ${row.business_name} » porte le numéro ${n}.`
          : `Votre boutique porte le numéro ${n}.`;
      blocks.push(
        `${hello} C'est Sebastiao. J'ai créé Patron.`,
        `${shopLine} Vous comptez parmi les premières, et ce numéro reste le vôtre.`,
        `Vous voulez une petite vidéo ? Elle montre comment noter votre premier crédit. Je vous l'envoie juste après ce message.`,
      );
      break;
    }
    case 'j1':
      blocks.push(
        `${hello} C'est Sebastiao. Hier, votre commerce est devenu le n° ${n} sur Patron.`,
        `Vous avez pu noter votre premier crédit ?`,
        `Si vous avez un souci, dites-le-moi. On le fait ensemble.`,
      );
      break;
    case 'j7':
      if (ctx.sales7d + ctx.credits7d > 0) {
        blocks.push(
          `${hello} Ça fait une semaine.`,
          `Cette semaine, vous avez noté ${ctx.sales7d} ventes et ${ctx.credits7d} crédits dans Patron. Tout reste dans votre téléphone. Rien ne se perd.`,
          `Dites-moi : vous avez récupéré de l'argent que vous pensiez perdu ?`,
          `Et si quelque chose vous gêne dans Patron, dites-le-moi franchement. C'est moi qui corrige.`,
        );
      } else {
        blocks.push(
          `${hello} C'est Sebastiao.`,
          `La vidéo du premier crédit reste là quand vous voulez. Sans pression.`,
          `Votre numéro ${n} vous attend.`,
        );
      }
      break;
    case 'repos':
      blocks.push(
        `${hello} Ce message reste le dernier de ma part.`,
        `Je respecte votre temps. Votre numéro ${n} reste le vôtre.`,
        `Un jour, si vous voulez retrouver l'argent qu'on vous doit, écrivez-moi.`,
        `Bon marché à vous.`,
      );
      break;
    case 'j30':
      blocks.push(
        `${hello} Ça fait un mois.`,
        `Vos crédits vivent dans votre téléphone depuis un mois. À votre arrivée, vous avez reçu le n° ${n}. Aujourd'hui, vous êtes ${ctx.total} boutiques.`,
        `Vous comptez parmi celles qui commencent l'histoire. Merci pour votre confiance.`,
        `Vous avez une amie qui vend comme vous ? Si elle donne des crédits, Patron peut l'aider aussi. Ajoutez-la depuis l'app. Le bouton Inviter se trouve en haut.`,
        `Ou parlez-lui de Patron avec vos mots. Vos mots valent plus que les miens.`,
      );
      break;
  }
  return blocks.join('\n\n');
}

// ─── Morning reminder (local notification, founder only) ─────────────────

export const MORNING_REMINDER_ID = 'founder-care-morning';
export const MORNING_REMINDER_ROUTE = '/(app)/founder-kpi/vendeurs?filtre=contact';
export const MORNING_REMINDER_HOUR = 8;

export function morningReminderBody(count: number): string {
  return count === 1 ? '1 personne à contacter aujourd\'hui' : `${count} personnes à contacter aujourd'hui`;
}

function getNotifications(): typeof import('expo-notifications') | null {
  try {
    return require('expo-notifications');
  } catch {
    return null; // binary without the native module: no-op
  }
}

/**
 * (Re)programs the daily 08:00 local reminder, or cancels it when nothing is
 * due. Fixed identifier, so calling it again replaces the previous one.
 * Best-effort: never throws. The caller must already have checked the founder.
 */
export async function syncMorningReminder(count: number): Promise<void> {
  const N = getNotifications();
  if (!N) return;
  try {
    await N.cancelScheduledNotificationAsync(MORNING_REMINDER_ID);
    if (count <= 0) return;
    await N.scheduleNotificationAsync({
      identifier: MORNING_REMINDER_ID,
      content: {
        title: 'Patron',
        body: morningReminderBody(count),
        data: { route: MORNING_REMINDER_ROUTE },
      },
      trigger: {
        type: N.SchedulableTriggerInputTypes.DAILY,
        hour: MORNING_REMINDER_HOUR,
        minute: 0,
      },
    });
  } catch {
    // failure: silent — a missing reminder never blocks the screen
  }
}
