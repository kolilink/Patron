import * as SecureStore from 'expo-secure-store';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://jnxpujsyvbenqgjbvifh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_z2cta2M53RtwpGoWUV6LMQ_LoUkSjaD';

// SecureStore has a 2 KB per-key limit; JWT sessions can exceed that.
// This adapter chunks large values across multiple keys.
const CHUNK_SIZE = 1900;

const LargeSecureStore = {
  async getItem(key: string): Promise<string | null> {
    const numChunksStr = await SecureStore.getItemAsync(`${key}.n`);
    if (numChunksStr === null) return null;
    const n = parseInt(numChunksStr, 10);
    const chunks: string[] = [];
    for (let i = 0; i < n; i++) {
      const chunk = await SecureStore.getItemAsync(`${key}.${i}`);
      if (chunk === null) return null;
      chunks.push(chunk);
    }
    return chunks.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    const n = Math.ceil(value.length / CHUNK_SIZE);
    await SecureStore.setItemAsync(`${key}.n`, String(n));
    for (let i = 0; i < n; i++) {
      await SecureStore.setItemAsync(`${key}.${i}`, value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    }
  },

  async removeItem(key: string): Promise<void> {
    const numChunksStr = await SecureStore.getItemAsync(`${key}.n`);
    if (numChunksStr === null) return;
    const n = parseInt(numChunksStr, 10);
    for (let i = 0; i < n; i++) {
      await SecureStore.deleteItemAsync(`${key}.${i}`);
    }
    await SecureStore.deleteItemAsync(`${key}.n`);
  },
};

const fetchWithTimeout: typeof fetch = (input, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  return fetch(input as RequestInfo, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer));
};

// Matches the key the SDK would derive on its own (`sb-<project-ref>-auth-token`)
// but set explicitly so this file is the single source of truth — the
// belt-and-suspenders clear below must always agree with what's actually
// persisted. Kept identical to the implicit default so existing sessions on
// devices already in the field aren't invalidated by this change.
const AUTH_STORAGE_KEY = 'sb-jnxpujsyvbenqgjbvifh-auth-token';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: LargeSecureStore,
    storageKey: AUTH_STORAGE_KEY,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  global: { fetch: fetchWithTimeout },
});

// Force-clears the Supabase auth token directly from SecureStore.
// Used as a belt-and-suspenders after signOut() — the Supabase client can return
// early without calling _removeSession() when the server returns a non-standard
// error (e.g. network timeout). That leaves the JWT in SecureStore so the next
// app launch would restore the session even though the user logged out.
export async function clearSupabaseLocalSession(): Promise<void> {
  try {
    await LargeSecureStore.removeItem(AUTH_STORAGE_KEY);
  } catch {}
}

// Directly calls the same endpoint supabase.auth.signOut() would, but using a
// bearer token captured up front rather than whatever session the client has
// loaded — so logout() can retry this later even after the local session has
// already been wiped. scope=global revokes the whole refresh-token family,
// matching signOut()'s default. Returns whether it actually reached the server.
export async function revokeAccessToken(accessToken: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/logout?scope=global`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return res.ok || res.status === 401 || res.status === 403; // already-invalid token counts as done
  } catch {
    return false;
  }
}
