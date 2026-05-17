import * as SQLite from 'expo-sqlite';

let _db: SQLite.SQLiteDatabase | null = null;

export async function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('patron.db');
  await _db.execAsync('PRAGMA journal_mode = WAL;');
  await migrate(_db);
  return _db;
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const row = await db.getFirstAsync<{ version: number | null }>(
    'SELECT MAX(version) as version FROM _migrations'
  );
  const current = row?.version ?? 0;

  if (current < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS local_products (
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
      );

      CREATE TABLE IF NOT EXISTS local_sale_orders (
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
      );

      CREATE TABLE IF NOT EXISTS local_so_lines (
        id         TEXT PRIMARY KEY,
        order_id   TEXT NOT NULL,
        product_id TEXT NOT NULL,
        qty        REAL NOT NULL,
        unit_price REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_payments (
        id           TEXT PRIMARY KEY,
        order_id     TEXT NOT NULL,
        method       TEXT NOT NULL,
        amount       REAL NOT NULL,
        ref_external TEXT,
        created_at   TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_queue (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id  TEXT NOT NULL,
        operation  TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      INSERT INTO _migrations (version) VALUES (1);
    `);
  }
}
