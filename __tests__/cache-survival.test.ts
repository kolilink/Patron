// CACHE SURVIVAL: a force-kill must never require going online again.
// SQLite and SecureStore both persist across kills; what can break survival is
// OUR code: a row written under a key that was never persisted, a read that fails
// silently, or a key mismatch. These tests simulate a process kill (fresh module
// registry = all JS state gone) with a SecureStore that survives, like the real one.
let persisted: Record<string, string> = {};

function freshProcess() {
  jest.resetModules();
  jest.doMock('expo-secure-store', () => ({
    // slow reads widen the window where concurrent first-time callers all see "no key"
    getItemAsync: async (k: string) => { await new Promise(r => setTimeout(r, 5)); return persisted[k] ?? null; },
    setItemAsync: async (k: string, v: string) => { await new Promise(r => setTimeout(r, 5)); persisted[k] = v; },
    deleteItemAsync: async (k: string) => { delete persisted[k]; },
  }));
  jest.doMock('expo-crypto', () => ({
    getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/encryption') as typeof import('@/lib/encryption');
}

describe('encryption key survives a force-kill', () => {
  beforeEach(() => { persisted = {}; });

  it('FIRST LAUNCH: many concurrent writes share ONE key — and every row still decrypts after the kill', async () => {
    const proc1 = freshProcess();
    // a fresh install: the cache warm-up, the dashboard and the outbox all encrypt at once
    const payloads = ['products', 'ventes', 'expenses', 'fournisseurs', 'queue-op-1', 'queue-op-2'].map(n => JSON.stringify({ n }));
    const stored = await Promise.all(payloads.map(p => proc1.encrypt(p)));

    // …force-kill: all JS state is gone, only SecureStore (the key) and SQLite (the rows) remain
    const proc2 = freshProcess();
    const back = await Promise.all(stored.map(s => proc2.decrypt(s)));
    expect(back).toEqual(payloads);
  });

  it('a second launch reads the persisted key and never regenerates it', async () => {
    const proc1 = freshProcess();
    const row = await proc1.encrypt('hello');
    const keyBefore = persisted['patron_db_enc_key_v1'];
    expect(keyBefore).toBeTruthy();
    const proc2 = freshProcess();
    expect(await proc2.decrypt(row)).toBe('hello');
    expect(persisted['patron_db_enc_key_v1']).toBe(keyBefore);
  });
});
