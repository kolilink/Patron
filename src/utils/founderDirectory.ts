// Founder vendor directory (the phone-number list): row shape, filters and the
// WhatsApp message the founder sends. Pure — the data comes from
// get_founder_vendor_directory() (db/migration_v238.sql), which already
// excludes test/demo businesses.

export interface DirectoryRow {
  business_id: string;
  business_name: string | null;
  owner_name: string | null;
  owner_phone: string | null;
  created_at: string;
  first_value_at: string | null;
  last_action_at: string | null;
  actions_7d: number;
  lost: boolean;
}

export type DirectoryFilter = 'tous' | 'perdus' | 'nouveaux';

export const DIRECTORY_FILTERS: { key: DirectoryFilter; label: string }[] = [
  { key: 'tous', label: 'Tous' },
  { key: 'perdus', label: 'Perdus' },
  { key: 'nouveaux', label: 'Nouveaux (7 j)' },
];

const DAY_MS = 86400000;

export function parseFilter(raw: string | string[] | undefined): DirectoryFilter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === 'perdus' || v === 'nouveaux' ? v : 'tous';
}

export function filterRows(rows: DirectoryRow[], filter: DirectoryFilter, now: number = Date.now()): DirectoryRow[] {
  if (filter === 'perdus') return rows.filter(r => r.lost);
  if (filter === 'nouveaux') return rows.filter(r => now - new Date(r.created_at).getTime() <= 7 * DAY_MS);
  return rows;
}

function firstName(row: DirectoryRow): string {
  return (row.owner_name ?? '').trim().split(/\s+/)[0] ?? '';
}

/** The message depends on where the vendor is: lost, brand new, or just active. */
export function whatsappMessage(row: DirectoryRow, now: number = Date.now()): string {
  const who = firstName(row);
  const hello = who ? `Bonjour ${who}` : 'Bonjour';
  const shop = row.business_name ? ` « ${row.business_name} »` : '';
  if (row.lost) {
    return `${hello}, ici l'équipe Patron. On a vu que vous n'avez pas utilisé Patron ces derniers jours — qu'est-ce qui vous a manqué ? Votre avis nous aide beaucoup.`;
  }
  if (!row.first_value_at && now - new Date(row.created_at).getTime() <= 7 * DAY_MS) {
    return `${hello}, ici l'équipe Patron. Merci d'avoir ouvert${shop} ! Voulez-vous qu'on note ensemble votre première vente ou dette ? Ça prend 2 minutes.`;
  }
  return `${hello}, ici l'équipe Patron. Comment se passe l'utilisation de Patron pour${shop || ' votre commerce'} ? Dites-nous ce qu'on peut améliorer.`;
}

/** wa.me link, or null when the row has no usable phone number. */
export function whatsappUrl(row: DirectoryRow, now: number = Date.now()): string | null {
  const digits = (row.owner_phone ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(whatsappMessage(row, now))}`;
}

export function daysAgoLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'jamais';
  const d = Math.floor((now - new Date(iso).getTime()) / DAY_MS);
  return d <= 0 ? "aujourd'hui" : `il y a ${d} j`;
}
