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

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: LargeSecureStore,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
