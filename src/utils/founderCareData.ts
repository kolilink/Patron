// Founder-only data access for the care plan: the vendor directory + the care
// state (contacts already made, 7-day sales/credits), and the morning
// reminder sync that depends on both. The pure logic lives in founderCare.ts.

import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/sync';
import type { DirectoryRow } from './founderDirectory';
import { todayCount, syncMorningReminder, type CareContact, type CareStateRow } from './founderCare';

export interface CareData {
  rows: DirectoryRow[];
  care: CareStateRow[];
}

/** Throws on failure — callers speak the failure. */
export async function loadCareData(): Promise<CareData> {
  const [dir, care] = await Promise.all([
    withTimeout(supabase.rpc('get_founder_vendor_directory')),
    withTimeout(supabase.rpc('get_founder_care_state')),
  ]);
  if (dir.error) throw dir.error;
  if (care.error) throw care.error;
  return { rows: (dir.data ?? []) as DirectoryRow[], care: (care.data ?? []) as CareStateRow[] };
}

export function contactsMap(care: CareStateRow[]): Record<string, CareContact[]> {
  const out: Record<string, CareContact[]> = {};
  for (const c of care) out[c.business_id] = c.contacts ?? [];
  return out;
}

export async function markCareContact(businessId: string, step: string): Promise<void> {
  const { error } = await withTimeout(supabase.rpc('mark_founder_care_contact', { p_business_id: businessId, p_step: step }));
  if (error) throw error;
}

let lastScheduledCount: number | null = null;

/** Reprograms the 08:00 reminder only when the count changed since last time. */
export async function updateMorningReminder(count: number): Promise<void> {
  if (lastScheduledCount === count) return;
  await syncMorningReminder(count);
  lastScheduledCount = count;
}

/** Fetch + count + reschedule; for screens that don't already hold the data. Never throws. */
export async function refreshMorningReminder(): Promise<void> {
  try {
    const { rows, care } = await loadCareData();
    await updateMorningReminder(todayCount(rows, contactsMap(care)));
  } catch {
    // failure: silent — the reminder is a convenience, the Vendeurs screen speaks its own errors
  }
}
