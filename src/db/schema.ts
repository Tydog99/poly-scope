import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 3;

export function initializeSchema(db: Database.Database): void {
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    -- Raw subgraph fills (one row per EnrichedOrderFilled)
    CREATE TABLE IF NOT EXISTS enriched_order_fills (
      id TEXT PRIMARY KEY,
      transaction_hash TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      order_hash TEXT NOT NULL,
      side TEXT NOT NULL,
      size INTEGER NOT NULL,
      price INTEGER NOT NULL,
      maker TEXT NOT NULL,
      taker TEXT NOT NULL,
      market TEXT NOT NULL
    );

    -- Wallet metadata
    CREATE TABLE IF NOT EXISTS accounts (
      wallet TEXT PRIMARY KEY,
      creation_timestamp INTEGER,
      synced_from INTEGER,
      synced_to INTEGER,
      synced_at INTEGER,
      trade_count_total INTEGER,
      collateral_volume INTEGER,
      profit INTEGER,
      has_full_history INTEGER DEFAULT 0
    );

    -- For profit calculation
    CREATE TABLE IF NOT EXISTS redemptions (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      payout INTEGER NOT NULL
    );

    -- Market metadata cache with sync tracking
    CREATE TABLE IF NOT EXISTS markets (
      token_id TEXT PRIMARY KEY,
      condition_id TEXT,
      question TEXT,
      outcome TEXT,
      outcome_index INTEGER,
      resolved_at INTEGER,
      synced_from INTEGER,
      synced_to INTEGER,
      synced_at INTEGER,
      has_complete_history INTEGER DEFAULT 0
    );

    -- Background job queue
    CREATE TABLE IF NOT EXISTS backfill_queue (
      wallet TEXT PRIMARY KEY,
      priority INTEGER DEFAULT 0,
      created_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    );

    -- Price history for market impact calculation
    CREATE TABLE IF NOT EXISTS price_history (
      token_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      price INTEGER NOT NULL,
      PRIMARY KEY (token_id, timestamp)
    );

    -- Indexes for fast queries
    CREATE INDEX IF NOT EXISTS idx_fills_maker_time ON enriched_order_fills(maker, timestamp);
    CREATE INDEX IF NOT EXISTS idx_fills_taker_time ON enriched_order_fills(taker, timestamp);
    CREATE INDEX IF NOT EXISTS idx_fills_market ON enriched_order_fills(market, timestamp);
    CREATE INDEX IF NOT EXISTS idx_fills_tx ON enriched_order_fills(transaction_hash);
    CREATE INDEX IF NOT EXISTS idx_redemptions_wallet ON redemptions(wallet);
    CREATE INDEX IF NOT EXISTS idx_prices_token_time ON price_history(token_id, timestamp);
  `);

  // Run migrations for existing databases
  runMigrations(db);

  // Record schema version if not exists
  const existing = db
    .prepare('SELECT version FROM schema_version WHERE version = ?')
    .get(SCHEMA_VERSION);

  if (!existing) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }
}

function runMigrations(db: Database.Database): void {
  // Get current schema version
  const currentVersion = db
    .prepare('SELECT MAX(version) as version FROM schema_version')
    .get() as { version: number | null } | undefined;

  const version = currentVersion?.version ?? 0;

  // Migration to version 2: Add sync columns to markets table
  if (version < 2) {
    // Check if columns already exist (in case of partial migration)
    const columns = db
      .prepare("PRAGMA table_info(markets)")
      .all() as { name: string }[];
    const columnNames = columns.map(c => c.name);

    if (!columnNames.includes('synced_from')) {
      db.exec('ALTER TABLE markets ADD COLUMN synced_from INTEGER');
    }
    if (!columnNames.includes('synced_to')) {
      db.exec('ALTER TABLE markets ADD COLUMN synced_to INTEGER');
    }
    if (!columnNames.includes('synced_at')) {
      db.exec('ALTER TABLE markets ADD COLUMN synced_at INTEGER');
    }
    if (!columnNames.includes('has_complete_history')) {
      db.exec('ALTER TABLE markets ADD COLUMN has_complete_history INTEGER DEFAULT 0');
    }
  }
}
