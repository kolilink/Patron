import * as SQLite from 'expo-sqlite';

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
  await db.runAsync(
    'INSERT INTO sync_queue (operation, payload) VALUES (?, ?)',
    [operation, JSON.stringify(payload)],
  );
}

export async function getPendingOps(): Promise<SyncQueueItem[]> {
  const db = await openDb();
  return db.getAllAsync<SyncQueueItem>(
    'SELECT * FROM sync_queue WHERE attempts < ? ORDER BY id ASC',
    [MAX_SYNC_ATTEMPTS],
  );
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
