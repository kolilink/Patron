// "À compléter" — in-progress products from the quick-add sheet.
//
// Replaces the temporary single "restore the last draft when the sheet opens" behaviour: the
// sheet now always opens FRESH, and whatever was half-filled when it was dismissed (swipe, Annuler,
// app kill) waits here, listed in Gérer mode as "À compléter (n)", at most MAX_DRAFTS, newest first.
//
// Local-only by design: stored in the device's SQLite kv_store (survives an app restart, wiped on
// account deletion with every other kv row). A draft is never synced and never touches the outbox.

import { getKV, setKV } from '@/lib/db';
import { isBlankDraft, type QuickAddState } from '@/src/utils/quickAddProduct';

export const MAX_DRAFTS = 3;

export interface QuickAddDraft {
  id: string;
  savedAt: number;
  state: QuickAddState;
}

const keyFor = (businessId: string) => `quick_add_drafts_${businessId}`;
// Single-draft key written by the previous build: migrated once, then emptied.
const legacyKeyFor = (businessId: string) => `quick_add_draft_${businessId}`;

let seq = 0;
export function newDraftId(): string {
  seq += 1;
  return `d-${Date.now().toString(36)}-${seq}`;
}

function isState(x: unknown): x is QuickAddState {
  const o = x as Partial<QuickAddState> | null;
  return !!o && typeof o === 'object' && typeof o.name === 'string' && typeof o.price === 'string' &&
    typeof o.qty === 'string' && typeof o.models === 'boolean' && Array.isArray(o.variants);
}

function parseList(raw: string | null): QuickAddDraft[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; } // corrupt = no drafts
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((d): d is QuickAddDraft => !!d && typeof d.id === 'string' && typeof d.savedAt === 'number' && isState(d.state) && !isBlankDraft(d.state))
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, MAX_DRAFTS);
}

async function write(businessId: string, drafts: QuickAddDraft[]): Promise<void> {
  await setKV(keyFor(businessId), drafts.length ? JSON.stringify(drafts) : '');
}

/** Newest first, at most MAX_DRAFTS. Folds in the old single draft the first time it is seen. */
export async function listQuickAddDrafts(businessId: string): Promise<QuickAddDraft[]> {
  if (!businessId) return [];
  const list = parseList(await getKV(keyFor(businessId)));
  const legacyRaw = await getKV(legacyKeyFor(businessId));
  if (legacyRaw) {
    let legacy: unknown = null;
    try { legacy = JSON.parse(legacyRaw); } catch { legacy = null; } // corrupt legacy draft = none
    await setKV(legacyKeyFor(businessId), '');
    if (isState(legacy) && !isBlankDraft(legacy)) {
      const merged = [{ id: newDraftId(), savedAt: Date.now(), state: legacy }, ...list].slice(0, MAX_DRAFTS);
      await write(businessId, merged);
      return merged;
    }
  }
  return list;
}

/** Upsert by id. A blank state removes the draft; the 4th draft pushes the oldest out. */
export async function saveQuickAddDraft(businessId: string, id: string, state: QuickAddState): Promise<void> {
  if (!businessId) return;
  const rest = (await listQuickAddDrafts(businessId)).filter(d => d.id !== id);
  const next = isBlankDraft(state) ? rest : [{ id, savedAt: Date.now(), state }, ...rest].slice(0, MAX_DRAFTS);
  await write(businessId, next);
}

export async function removeQuickAddDraft(businessId: string, id: string): Promise<void> {
  if (!businessId) return;
  await write(businessId, (await listQuickAddDrafts(businessId)).filter(d => d.id !== id));
}
