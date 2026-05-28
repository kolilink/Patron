import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Membership } from '@/src/types';

export interface KnownBusiness {
  id: string;
  name: string;
  active: boolean;
  removedAt?: string;
}

function storageKey(userId: string) {
  return `patron_known_businesses_${userId}`;
}

export async function getKnownBusinesses(userId: string): Promise<KnownBusiness[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(userId));
    if (!raw) return [];
    return JSON.parse(raw) as KnownBusiness[];
  } catch {
    return [];
  }
}

// Call after every successful loadSession. Returns the businesses that were
// present in the cache but are missing from currentMemberships (i.e. removed).
export async function syncKnownBusinesses(
  userId: string,
  currentMemberships: Membership[],
): Promise<KnownBusiness[]> {
  try {
    const existing = await getKnownBusinesses(userId);
    const currentIds = new Set(currentMemberships.map(m => m.business_id));
    const now = new Date().toISOString();

    const updated: KnownBusiness[] = existing.map(b => {
      if (b.active && !currentIds.has(b.id)) {
        return { ...b, active: false, removedAt: now };
      }
      return b;
    });

    const existingIds = new Set(existing.map(b => b.id));
    for (const m of currentMemberships) {
      if (!existingIds.has(m.business_id)) {
        updated.push({
          id: m.business_id,
          name: (m.business as { name?: string })?.name ?? m.business_id,
          active: true,
        });
      }
    }

    await AsyncStorage.setItem(storageKey(userId), JSON.stringify(updated));

    return updated.filter(b => !b.active && b.removedAt === now);
  } catch {
    return [];
  }
}

export async function dismissRemovedBusiness(userId: string, businessId: string): Promise<void> {
  try {
    const existing = await getKnownBusinesses(userId);
    const updated = existing.filter(b => b.id !== businessId);
    await AsyncStorage.setItem(storageKey(userId), JSON.stringify(updated));
  } catch {
    // ignore
  }
}
