// Shared message-clustering logic for every 1:1/group chat surface in the app
// (Ma Boutique, Le Marché DMs, and merchant↔founder support). Consecutive
// messages from the same sender within GROUP_GAP_MS collapse into one visual
// cluster: shared corner radii, and — the key restraint move — a single
// timestamp for the whole cluster instead of one repeated on every bubble.

export type GroupPos = 'standalone' | 'first' | 'middle' | 'last';

export type Groupable = { id: string; sender_id: string; created_at: string };

export type SeparatorItem = { _sep: true; label: string; id: string };
export type GroupedItem<T> = (T & { _pos: GroupPos }) | SeparatorItem;

export function isSep<T>(item: GroupedItem<T>): item is SeparatorItem {
  return '_sep' in item;
}

const GROUP_GAP_MS = 5 * 60_000; // same cluster if < 5 min apart

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function sameGroup(a: Groupable, b: Groupable): boolean {
  return a.sender_id === b.sender_id
    && Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) < GROUP_GAP_MS;
}

const FR_DAYS   = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const FR_MONTHS = ['jan', 'fév', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

export function timeSepLabel(iso: string): string {
  const d         = new Date(iso);
  const today     = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today))     return "Aujourd'hui";
  if (sameDay(d, yesterday)) return 'Hier';
  const daysDiff = Math.floor((today.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
  if (daysDiff < 7) return FR_DAYS[d.getDay()];
  return `${d.getDate()} ${FR_MONTHS[d.getMonth()]}`;
}

// msgs is newest-first; callers typically feed this into an inverted FlatList
// so index 0 renders at the bottom. Visual order: 'first' = topmost (oldest
// in group), 'last' = bottommost (newest) — the one that keeps the timestamp.
export function buildGroupedItems<T extends Groupable>(msgs: T[]): GroupedItem<T>[] {
  if (msgs.length === 0) return [];

  const bubbles = msgs.map((msg, i) => {
    const newer = msgs[i - 1]; // lower index → newer → visually below
    const older = msgs[i + 1]; // higher index → older → visually above
    const withNewer = newer ? sameGroup(msg, newer) : false;
    const withOlder = older ? sameGroup(msg, older) : false;
    let pos: GroupPos;
    if (!withNewer && !withOlder)     pos = 'standalone';
    else if (!withNewer && withOlder) pos = 'last';   // visually bottom of group
    else if (withNewer && !withOlder) pos = 'first';  // visually top of group
    else                              pos = 'middle';
    return { ...msg, _pos: pos } as T & { _pos: GroupPos };
  });

  const out: GroupedItem<T>[] = [];
  for (let i = 0; i < bubbles.length; i++) {
    out.push(bubbles[i]);
    const nextMsg = msgs[i + 1];
    // Insert one separator per calendar-day boundary.
    if (nextMsg && !sameDay(new Date(msgs[i].created_at), new Date(nextMsg.created_at))) {
      out.push({ _sep: true, label: timeSepLabel(msgs[i].created_at), id: `tsep-${msgs[i].id}` });
    }
  }
  out.push({ _sep: true, label: timeSepLabel(msgs[msgs.length - 1].created_at), id: 'tsep-oldest' });
  return out;
}

export function bubbleMargins(pos: GroupPos): { marginTop: number; marginBottom: number } {
  switch (pos) {
    case 'standalone': return { marginTop: 8, marginBottom: 8 };
    case 'first':      return { marginTop: 8, marginBottom: 2 };
    case 'middle':     return { marginTop: 2, marginBottom: 2 };
    case 'last':       return { marginTop: 2, marginBottom: 8 };
  }
}

export function bubbleRadius(isOwn: boolean, pos: GroupPos) {
  if (pos === 'standalone') return { borderRadius: 18 };
  if (isOwn) {
    return {
      borderTopLeftRadius:     18,
      borderBottomLeftRadius:  18,
      borderTopRightRadius:    pos === 'first' ? 18 : 5,
      borderBottomRightRadius: pos === 'last'  ? 18 : 5,
    };
  }
  return {
    borderTopLeftRadius:     pos === 'first' ? 18 : 5,
    borderBottomLeftRadius:  pos === 'last'  ? 18 : 5,
    borderTopRightRadius:    18,
    borderBottomRightRadius: 18,
  };
}

// Whether this cluster position should carry the (single, shared) timestamp.
export function showsMeta(pos: GroupPos): boolean {
  return pos === 'standalone' || pos === 'last';
}
