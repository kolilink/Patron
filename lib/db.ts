import * as SQLite from 'expo-sqlite';
import type { Product } from '@/src/types';
import { encrypt, decrypt } from '@/lib/encryption';

// Cache the Promise so concurrent callers all await the same migration run.
let _dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('patron.db');
      await db.execAsync('PRAGMA journal_mode = WAL');
      await migrate(db);
      return db;
    })();
  }
  return _dbPromise;
}

// Each statement is its own execAsync call — Expo SQLite silently drops
// subsequent statements when multiple DDL operations are batched in one string.
async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime(\'now\')))',
  );

  const row = await db.getFirstAsync<{ version: number | null }>(
    'SELECT MAX(version) as version FROM _migrations',
  );
  const current = row?.version ?? 0;

  if (current < 1) {
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS local_products (
        id            TEXT PRIMARY KEY,
        business_id   TEXT NOT NULL,
        name          TEXT NOT NULL,
        sku           TEXT,
        category      TEXT,
        unit          TEXT DEFAULT 'pcs',
        cost_price    REAL DEFAULT 0,
        sale_price    REAL DEFAULT 0,
        reorder_level REAL DEFAULT 0,
        stock_qty     REAL DEFAULT 0,
        archived      INTEGER DEFAULT 0,
        created_at    TEXT,
        updated_at    TEXT,
        created_by    TEXT,
        synced_at     TEXT,
        dirty         INTEGER DEFAULT 0
      )`,
    );
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS local_sale_orders (
        id            TEXT PRIMARY KEY,
        business_id   TEXT NOT NULL,
        customer_name TEXT,
        seller_id     TEXT NOT NULL,
        status        TEXT DEFAULT 'brouillon',
        paid_at       TEXT,
        total_amount  REAL DEFAULT 0,
        created_at    TEXT,
        updated_at    TEXT,
        created_by    TEXT,
        synced_at     TEXT,
        dirty         INTEGER DEFAULT 0
      )`,
    );
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS local_so_lines (
        id         TEXT PRIMARY KEY,
        order_id   TEXT NOT NULL,
        product_id TEXT NOT NULL,
        qty        REAL NOT NULL,
        unit_price REAL NOT NULL
      )`,
    );
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS local_payments (
        id           TEXT PRIMARY KEY,
        order_id     TEXT NOT NULL,
        method       TEXT NOT NULL,
        amount       REAL NOT NULL,
        ref_external TEXT,
        created_at   TEXT
      )`,
    );
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS sync_queue (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id  TEXT NOT NULL,
        operation  TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
    );
    await db.execAsync('INSERT INTO _migrations (version) VALUES (1)');
  }

  if (current < 2) {
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS local_payments_v2 (
        id            TEXT PRIMARY KEY,
        order_id      TEXT,
        customer_name TEXT,
        business_id   TEXT,
        method        TEXT NOT NULL,
        amount        REAL NOT NULL,
        date          TEXT NOT NULL DEFAULT (date('now')),
        ref_external  TEXT,
        created_at    TEXT,
        synced_at     TEXT,
        dirty         INTEGER DEFAULT 0
      )`,
    );
    await db.execAsync(
      `INSERT OR IGNORE INTO local_payments_v2 (id, order_id, method, amount, ref_external, created_at)
       SELECT id, order_id, method, amount, ref_external, created_at FROM local_payments`,
    );
    await db.execAsync('DROP TABLE IF EXISTS local_payments');
    await db.execAsync('ALTER TABLE local_payments_v2 RENAME TO local_payments');
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (2)');
  }

  if (current < 3) {
    await db.execAsync('ALTER TABLE local_sale_orders ADD COLUMN sale_date TEXT');
    await db.execAsync('ALTER TABLE local_sale_orders ADD COLUMN discount_amount REAL DEFAULT 0');
    await db.execAsync('ALTER TABLE local_sale_orders ADD COLUMN is_credit INTEGER DEFAULT 0');
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (3)');
  }

  if (current < 4) {
    await db.execAsync('DROP TABLE IF EXISTS local_payments');
    await db.execAsync(
      `CREATE TABLE local_payments (
        id            TEXT PRIMARY KEY,
        order_id      TEXT,
        customer_name TEXT,
        business_id   TEXT,
        method        TEXT NOT NULL DEFAULT 'especes',
        amount        REAL NOT NULL DEFAULT 0,
        date          TEXT NOT NULL DEFAULT (date('now')),
        ref_external  TEXT,
        created_at    TEXT,
        synced_at     TEXT,
        dirty         INTEGER DEFAULT 0
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (4)');
  }

  if (current < 5) {
    // Defensive check: if local_payments somehow still lacks the amount column
    // (from a device where v2/v4 recorded success but the DDL silently failed),
    // use PRAGMA to detect and force-recreate the table.
    const cols = await db.getAllAsync<{ name: string }>(
      'PRAGMA table_info(local_payments)',
    );
    if (!cols.some(c => c.name === 'amount')) {
      await db.execAsync('DROP TABLE IF EXISTS local_payments');
      await db.execAsync(
        `CREATE TABLE local_payments (
          id            TEXT PRIMARY KEY,
          order_id      TEXT,
          customer_name TEXT,
          business_id   TEXT,
          method        TEXT NOT NULL DEFAULT 'especes',
          amount        REAL NOT NULL DEFAULT 0,
          date          TEXT NOT NULL DEFAULT (date('now')),
          ref_external  TEXT,
          created_at    TEXT,
          synced_at     TEXT,
          dirty         INTEGER DEFAULT 0
        )`,
      );
    }
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (5)');
  }

  if (current < 6) {
    // sync_queue was created in v1 but never implemented — no code writes to it
    // or drains it. Removing it to eliminate false promise of offline sync.
    await db.execAsync('DROP TABLE IF EXISTS sync_queue');
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (6)');
  }

  if (current < 7) {
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS sync_queue (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        operation  TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        attempts   INTEGER DEFAULT 0,
        last_error TEXT
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (7)');
  }

  if (current < 8) {
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS product_cache (
        business_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (8)');
  }

  if (current < 9) {
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS ventes_cache (
        cache_key TEXT PRIMARY KEY,
        data      TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      )`,
    );
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS fournisseur_cache (
        business_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      )`,
    );
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS commande_cache (
        business_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      )`,
    );
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS expense_cache (
        business_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (9)');
  }

  if (current < 10) {
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS dashboard_kpi_cache (
        business_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (10)');
  }

  if (current < 11) {
    // Wipe all cache tables — they contain plaintext data.
    // They will be re-populated with AES-256-GCM encrypted data on next online fetch.
    await db.execAsync('DELETE FROM product_cache');
    await db.execAsync('DELETE FROM ventes_cache');
    await db.execAsync('DELETE FROM fournisseur_cache');
    await db.execAsync('DELETE FROM commande_cache');
    await db.execAsync('DELETE FROM expense_cache');
    await db.execAsync('DELETE FROM dashboard_kpi_cache');
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (11)');
  }

  if (current < 12) {
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS kv_store (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (12)');
  }

  if (current < 13) {
    // Clear plaintext sync_queue rows — going forward all payloads are AES-256-GCM encrypted.
    // Any items that were pending will be lost, but the next online session re-fetches from Supabase.
    await db.execAsync('DELETE FROM sync_queue');
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (13)');
  }

  if (current < 14) {
    // dead_ops: permanent graveyard for sync_queue items that exhausted MAX_SYNC_ATTEMPTS
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS dead_ops (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        operation  TEXT NOT NULL,
        payload    TEXT NOT NULL,
        died_at    TEXT DEFAULT (datetime('now')),
        last_error TEXT
      )`,
    );
    // chat_cache: rooms + messages snapshot per business
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS chat_cache (
        business_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      )`,
    );
    // market_cache: market posts snapshot (global, no business key needed)
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS market_cache (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        data      TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (14)');
  }

  if (current < 15) {
    // rapports_cache: last successful reports snapshot per business, so the
    // Rapports screen can show real numbers offline instead of silent zeros.
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS rapports_cache (
        business_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (15)');
  }

  if (current < 16) {
    // investor_cache / equipe_cache / partnerships_cache: same offline-fallback
    // treatment as products/ventes/rapports — these screens had none, so they
    // went blank or silently stale offline instead of showing last-known data.
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS investor_cache (
        cache_key TEXT PRIMARY KEY,
        data      TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      )`,
    );
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS equipe_cache (
        business_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      )`,
    );
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS partnerships_cache (
        business_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (16)');
  }

  if (current < 17) {
    // apports_cache: capital injections had no offline read cache at all —
    // going offline showed a raw error instead of the last-known data.
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS apports_cache (
        business_id TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        cached_at   INTEGER NOT NULL
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (17)');
  }

  if (current < 18) {
    // client_ledger_cache: the per-client ledger (clients/[name].tsx) had no
    // offline cache for its payments/record reads — unlike the sales list
    // (already cached via ventes_cache), a client's payment history came back
    // empty offline, silently inflating their shown debt to the full lifetime
    // sale total instead of sale total minus payments. Shares one table for
    // both reads via key prefix: `${businessId}:payments:${clientKey}` and
    // `${businessId}:record:${clientKey}` — same generic cache_key shape as
    // ventes_cache.
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS client_ledger_cache (
        cache_key TEXT PRIMARY KEY,
        data      TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      )`,
    );
    await db.execAsync('INSERT OR IGNORE INTO _migrations (version) VALUES (18)');
  }
}

export async function getKV(key: string): Promise<string | null> {
  const db = await openDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv_store WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setKV(key: string, value: string): Promise<void> {
  const db = await openDb();
  await db.runAsync('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)', [key, value]);
}

export async function getLocalSaleCount(): Promise<number> {
  const db = await openDb();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM local_sale_orders WHERE business_id = ?',
    ['local'],
  );
  return row?.count ?? 0;
}

// ─── Sync queue ───────────────────────────────────────────────────────────────

export interface SyncQueueItem {
  id: number;
  operation: string;
  payload: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
}

const MAX_SYNC_ATTEMPTS = 5;

export async function enqueue(operation: string, payload: object): Promise<void> {
  const db = await openDb();
  let stored: string;
  try {
    stored = await encrypt(JSON.stringify(payload));
  } catch {
    // SubtleCrypto unavailable (very old device or dev env) — store with PLAIN: prefix.
    // base64 output of encrypt() can never start with 'PLAIN:' (colon is not valid base64),
    // so this prefix is an unambiguous marker.
    stored = 'PLAIN:' + JSON.stringify(payload);
  }
  await db.runAsync(
    'INSERT INTO sync_queue (operation, payload) VALUES (?, ?)',
    [operation, stored],
  );
}

export async function getPendingOps(): Promise<SyncQueueItem[]> {
  const db = await openDb();
  const rows = await db.getAllAsync<SyncQueueItem>(
    'SELECT * FROM sync_queue WHERE attempts < ? ORDER BY id ASC',
    [MAX_SYNC_ATTEMPTS],
  );
  const result: SyncQueueItem[] = [];
  for (const row of rows) {
    try {
      const payload = row.payload.startsWith('PLAIN:')
        ? row.payload.slice(6)
        : await decrypt(row.payload);
      result.push({ ...row, payload });
    } catch {
      // Decryption failed — exclude from this drain pass; item retried next foreground
    }
  }
  return result;
}

export async function deleteQueueItem(id: number): Promise<void> {
  const db = await openDb();
  await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [id]);
}

export async function markAttemptFailed(id: number, error: string): Promise<void> {
  const db = await openDb();
  await db.runAsync(
    'UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?',
    [error, id],
  );
}

export async function getQueueCount(): Promise<number> {
  const db = await openDb();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM sync_queue WHERE attempts < ?',
    [MAX_SYNC_ATTEMPTS],
  );
  return row?.count ?? 0;
}

export async function getDeadCount(): Promise<number> {
  const db = await openDb();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM sync_queue WHERE attempts >= ?',
    [MAX_SYNC_ATTEMPTS],
  );
  return row?.count ?? 0;
}

export async function clearDeadOps(): Promise<void> {
  const db = await openDb();
  await db.runAsync('DELETE FROM sync_queue WHERE attempts >= ?', [MAX_SYNC_ATTEMPTS]);
}

export interface DeadOpItem {
  id: number;
  operation: string;
  last_error: string | null;
}

export async function getDeadOps(): Promise<DeadOpItem[]> {
  const db = await openDb();
  return db.getAllAsync<DeadOpItem>(
    'SELECT id, operation, last_error FROM sync_queue WHERE attempts >= ?',
    [MAX_SYNC_ATTEMPTS],
  );
}

// Move dead items to the graveyard table, then purge from sync_queue.
export async function archiveDeadOps(): Promise<void> {
  const db = await openDb();
  await db.runAsync(
    `INSERT INTO dead_ops (operation, payload, last_error)
     SELECT operation, payload, last_error FROM sync_queue WHERE attempts >= ?`,
    [MAX_SYNC_ATTEMPTS],
  );
  await db.runAsync('DELETE FROM sync_queue WHERE attempts >= ?', [MAX_SYNC_ATTEMPTS]);
}

// ─── Shared encrypted-cache writer ─────────────────────────────────────────────
// Every store re-fetches and re-writes its whole cache on every screen focus,
// even when nothing changed. Encryption is pure-JS AES on the JS thread (see
// lib/encryption.ts — deliberately no native crypto), so re-encrypting an
// unchanged payload on every navigation is the main driver of nav jank on
// low-end Android. This guard skips the AES when the payload is identical to
// the last one written for this key (the common re-focus case), and only then
// refreshes cached_at so the offline-freshness indicator is unaffected.
//
// Safe by construction: a hash match means the row already holds exactly this
// payload, so skipping the re-encrypt cannot lose anything. The map is
// in-memory (cleared on restart) — the first write per key each session always
// runs, refreshing the persisted row; the SQLite cache itself already survives
// restarts. table/keyCol are hardcoded constants, never user input.
const _lastCacheHash = new Map<string, number>();

function cheapHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

async function writeCache(opts: {
  table: string;
  keyCol: string;
  keyValue: string | number;
  json: string;
  hashKey: string;
}): Promise<void> {
  const { table, keyCol, keyValue, json, hashKey } = opts;
  const h = cheapHash(json);
  const db = await openDb();
  if (_lastCacheHash.get(hashKey) === h) {
    await db.runAsync(`UPDATE ${table} SET cached_at = ? WHERE ${keyCol} = ?`, [Date.now(), keyValue]);
    return;
  }
  const encrypted = await encrypt(json);
  await db.runAsync(
    `INSERT OR REPLACE INTO ${table} (${keyCol}, data, cached_at) VALUES (?, ?, ?)`,
    [keyValue, encrypted, Date.now()],
  );
  _lastCacheHash.set(hashKey, h);
}

// ─── Dashboard KPI cache ──────────────────────────────────────────────────────

export async function saveDashboardKpiCache(businessId: string, kpis: unknown): Promise<void> {
  try {
    await writeCache({ table: 'dashboard_kpi_cache', keyCol: 'business_id', keyValue: businessId, json: JSON.stringify(kpis), hashKey: 'dashboard:' + businessId });
  } catch { }
}

export async function getDashboardKpiCache(businessId: string): Promise<unknown | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM dashboard_kpi_cache WHERE business_id = ?',
      [businessId],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// ─── Rapports snapshot cache ────────────────────────────────────────────────────

export async function saveRapportsCache(businessId: string, snapshot: unknown): Promise<void> {
  try {
    await writeCache({ table: 'rapports_cache', keyCol: 'business_id', keyValue: businessId, json: JSON.stringify(snapshot), hashKey: 'rapports:' + businessId });
  } catch { }
}

export async function getRapportsCache(businessId: string): Promise<unknown | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM rapports_cache WHERE business_id = ?',
      [businessId],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// ─── Investor balance/payouts cache ────────────────────────────────────────────

export async function saveInvestorCache(cacheKey: string, data: unknown): Promise<void> {
  try {
    await writeCache({ table: 'investor_cache', keyCol: 'cache_key', keyValue: cacheKey, json: JSON.stringify(data), hashKey: 'investor:' + cacheKey });
  } catch { }
}

export async function getInvestorCache(cacheKey: string): Promise<unknown | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM investor_cache WHERE cache_key = ?',
      [cacheKey],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// ─── Equipe (team) cache ───────────────────────────────────────────────────────

export async function saveEquipeCache(businessId: string, membres: unknown): Promise<void> {
  try {
    await writeCache({ table: 'equipe_cache', keyCol: 'business_id', keyValue: businessId, json: JSON.stringify(membres), hashKey: 'equipe:' + businessId });
  } catch { }
}

export async function getEquipeCache(businessId: string): Promise<unknown | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM equipe_cache WHERE business_id = ?',
      [businessId],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// ─── Partnerships cache ────────────────────────────────────────────────────────

export async function savePartnershipsCache(businessId: string, data: unknown): Promise<void> {
  try {
    await writeCache({ table: 'partnerships_cache', keyCol: 'business_id', keyValue: businessId, json: JSON.stringify(data), hashKey: 'partnerships:' + businessId });
  } catch { }
}

export async function getPartnershipsCache(businessId: string): Promise<unknown | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM partnerships_cache WHERE business_id = ?',
      [businessId],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// ─── Product read cache ────────────────────────────────────────────────────────

export async function saveProductCache(businessId: string, products: Product[]): Promise<void> {
  try {
    await writeCache({ table: 'product_cache', keyCol: 'business_id', keyValue: businessId, json: JSON.stringify(products), hashKey: 'product:' + businessId });
  } catch { }
}

export async function getProductCache(businessId: string): Promise<Product[] | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM product_cache WHERE business_id = ?',
      [businessId],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted) as Product[];
  } catch {
    return null;
  }
}

// ─── Ventes read cache ─────────────────────────────────────────────────────────
// key = `${businessId}:${sellerId ?? 'all'}`

export async function saveVentesCache(cacheKey: string, data: unknown[]): Promise<void> {
  try {
    await writeCache({ table: 'ventes_cache', keyCol: 'cache_key', keyValue: cacheKey, json: JSON.stringify(data), hashKey: 'ventes:' + cacheKey });
  } catch { }
}

export async function getVentesCache(cacheKey: string): Promise<unknown[] | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM ventes_cache WHERE cache_key = ?',
      [cacheKey],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted) as unknown[];
  } catch {
    return null;
  }
}

// ─── Fournisseur read cache ────────────────────────────────────────────────────

export async function saveFournisseurCache(businessId: string, data: unknown[]): Promise<void> {
  try {
    await writeCache({ table: 'fournisseur_cache', keyCol: 'business_id', keyValue: businessId, json: JSON.stringify(data), hashKey: 'fournisseur:' + businessId });
  } catch { }
}

export async function getFournisseurCache(businessId: string): Promise<unknown[] | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM fournisseur_cache WHERE business_id = ?',
      [businessId],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted) as unknown[];
  } catch {
    return null;
  }
}

// ─── Commande read cache ───────────────────────────────────────────────────────

export async function saveCommandeCache(businessId: string, data: unknown[]): Promise<void> {
  try {
    await writeCache({ table: 'commande_cache', keyCol: 'business_id', keyValue: businessId, json: JSON.stringify(data), hashKey: 'commande:' + businessId });
  } catch { }
}

export async function getCommandeCache(businessId: string): Promise<unknown[] | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM commande_cache WHERE business_id = ?',
      [businessId],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted) as unknown[];
  } catch {
    return null;
  }
}

// ─── Expense read cache ────────────────────────────────────────────────────────

export async function saveExpenseCache(businessId: string, data: unknown[]): Promise<void> {
  try {
    await writeCache({ table: 'expense_cache', keyCol: 'business_id', keyValue: businessId, json: JSON.stringify(data), hashKey: 'expense:' + businessId });
  } catch { }
}

export async function getExpenseCache(businessId: string): Promise<unknown[] | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM expense_cache WHERE business_id = ?',
      [businessId],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted) as unknown[];
  } catch {
    return null;
  }
}

// ─── Chat read cache ────────────────────────────────────────────────────────────

export async function saveChatCache(businessId: string, data: unknown): Promise<void> {
  try {
    await writeCache({ table: 'chat_cache', keyCol: 'business_id', keyValue: businessId, json: JSON.stringify(data), hashKey: 'chat:' + businessId });
  } catch { }
}

export async function getChatCache(businessId: string): Promise<unknown | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM chat_cache WHERE business_id = ?',
      [businessId],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// ─── Market read cache ──────────────────────────────────────────────────────────

export async function saveMarketCache(data: unknown[]): Promise<void> {
  try {
    await writeCache({ table: 'market_cache', keyCol: 'id', keyValue: 1, json: JSON.stringify(data), hashKey: 'market' });
  } catch { }
}

export async function getMarketCache(): Promise<unknown[] | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM market_cache WHERE id = 1');
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted) as unknown[];
  } catch {
    return null;
  }
}

// ─── Apports (capital injections) read cache ───────────────────────────────────

export async function saveApportsCache(businessId: string, data: unknown[]): Promise<void> {
  try {
    await writeCache({ table: 'apports_cache', keyCol: 'business_id', keyValue: businessId, json: JSON.stringify(data), hashKey: 'apports:' + businessId });
  } catch { }
}

export async function getApportsCache(businessId: string): Promise<unknown[] | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM apports_cache WHERE business_id = ?',
      [businessId],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted) as unknown[];
  } catch {
    return null;
  }
}

// ─── Client ledger read cache ───────────────────────────────────────────────────
// key = `${businessId}:payments:${clientKey}` or `${businessId}:record:${clientKey}`

export async function saveClientLedgerCache(cacheKey: string, data: unknown): Promise<void> {
  try {
    await writeCache({ table: 'client_ledger_cache', keyCol: 'cache_key', keyValue: cacheKey, json: JSON.stringify(data), hashKey: 'clientLedger:' + cacheKey });
  } catch { }
}

export async function getClientLedgerCache(cacheKey: string): Promise<unknown | null> {
  try {
    const db = await openDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM client_ledger_cache WHERE cache_key = ?',
      [cacheKey],
    );
    if (!row) return null;
    const decrypted = await decrypt(row.data);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// ─── Cache diagnostics ───────────────────────────────────────────────────────
// Every save*Cache/get*Cache pair above swallows its own errors (`catch {}`)
// so a write failure has never been observable — this exists to answer, on
// the device itself, whether the cache tables actually contain anything at
// all, distinguishing three very different failure modes that all *look*
// the same from the UI ("nothing shows offline"): (1) openDb()/migrate()
// itself is failing (every table reports -1), (2) the DB is fine but writes
// never ran or never completed (every table reports 0 despite having
// browsed the matching screen online), or (3) data really is cached (count
// > 0) and the bug is downstream in how a screen reads/renders it.
const CACHE_TABLE_NAMES = [
  'product_cache', 'ventes_cache', 'expense_cache', 'fournisseur_cache',
  'commande_cache', 'dashboard_kpi_cache', 'chat_cache', 'market_cache',
  'rapports_cache', 'investor_cache', 'equipe_cache', 'partnerships_cache',
  'apports_cache', 'client_ledger_cache',
] as const;

export async function getCacheDiagnostics(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  try {
    const db = await openDb();
    for (const table of CACHE_TABLE_NAMES) {
      try {
        const row = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM ${table}`);
        counts[table] = row?.c ?? 0;
      } catch {
        counts[table] = -1;
      }
    }
  } catch {
    // openDb()/migrate() itself failed — every table gets -1 so this reads
    // the same as "every individual query failed", which is the correct signal.
    for (const table of CACHE_TABLE_NAMES) counts[table] = -1;
  }
  return counts;
}

// getCacheDiagnostics() answered "is anything cached" (no — every table read
// 0, not -1, so the tables/DB are fine and the writes themselves never land).
// This runs the exact same steps a real save*Cache/get*Cache call goes
// through — openDb, encrypt, SQLite insert, SQLite read, decrypt — one at a
// time against a throwaway scratch row, and reports the real exception
// message at whichever step actually fails, instead of a caller's blanket
// `catch {}` swallowing it. Cleans up its own scratch row either way.
export async function testCacheWritePath(): Promise<string> {
  const steps: string[] = [];
  const SCRATCH_KEY = '__diag_test__';
  try {
    steps.push('1. openDb: début');
    const db = await openDb();
    steps.push('1. openDb: OK');

    steps.push('2. encrypt: début');
    const plaintext = JSON.stringify({ test: true, ts: Date.now() });
    const encrypted = await encrypt(plaintext);
    steps.push(`2. encrypt: OK (${encrypted.length} caractères)`);

    steps.push('3. écriture SQLite: début');
    await db.runAsync(
      'INSERT OR REPLACE INTO product_cache (business_id, data, cached_at) VALUES (?, ?, ?)',
      [SCRATCH_KEY, encrypted, Date.now()],
    );
    steps.push('3. écriture SQLite: OK');

    steps.push('4. lecture SQLite: début');
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM product_cache WHERE business_id = ?',
      [SCRATCH_KEY],
    );
    steps.push(row ? '4. lecture SQLite: OK' : '4. lecture SQLite: AUCUNE LIGNE TROUVÉE');

    if (row) {
      steps.push('5. decrypt: début');
      const decrypted = await decrypt(row.data);
      steps.push(decrypted === plaintext ? '5. decrypt: OK, correspond' : '5. decrypt: ÉCHEC, ne correspond pas');
    }

    await db.runAsync('DELETE FROM product_cache WHERE business_id = ?', [SCRATCH_KEY]);
    steps.push('6. nettoyage: OK');
  } catch (err) {
    steps.push(`ÉCHEC: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
  return steps.join('\n');
}

// ─── Cache timestamp helper ─────────────────────────────────────────────────────
// Returns the epoch-ms timestamp when a cache table was last written for a given key.
// Used by stores to expose staleness info to the UI.

type CacheTable =
  | 'product_cache'
  | 'ventes_cache'
  | 'expense_cache'
  | 'fournisseur_cache'
  | 'commande_cache'
  | 'dashboard_kpi_cache'
  | 'chat_cache'
  | 'market_cache'
  | 'rapports_cache'
  | 'investor_cache'
  | 'equipe_cache'
  | 'partnerships_cache'
  | 'apports_cache'
  | 'client_ledger_cache';

export async function getCacheTimestamp(table: CacheTable, key?: string): Promise<number | null> {
  try {
    const db = await openDb();
    if (table === 'market_cache') {
      const row = await db.getFirstAsync<{ cached_at: number }>('SELECT cached_at FROM market_cache WHERE id = 1');
      return row?.cached_at ?? null;
    }
    const keyCol = (table === 'ventes_cache' || table === 'investor_cache' || table === 'client_ledger_cache') ? 'cache_key' : 'business_id';
    const row = await db.getFirstAsync<{ cached_at: number }>(
      `SELECT cached_at FROM ${table} WHERE ${keyCol} = ?`,
      [key ?? ''],
    );
    return row?.cached_at ?? null;
  } catch {
    return null;
  }
}
