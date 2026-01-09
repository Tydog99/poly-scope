import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

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

    -- Core trade data (one row per fill)
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      tx_hash TEXT NOT NULL,
      wallet TEXT NOT NULL,
      market_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      side TEXT NOT NULL,
      action TEXT NOT NULL,
      role TEXT NOT NULL,
      size INTEGER NOT NULL,
      price INTEGER NOT NULL,
      value_usd INTEGER NOT NULL
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

    -- Market metadata cache
    CREATE TABLE IF NOT EXISTS markets (
      token_id TEXT PRIMARY KEY,
      condition_id TEXT,
      question TEXT,
      outcome TEXT,
      outcome_index INTEGER,
      resolved_at INTEGER
    );

    -- Background job queue
    CREATE TABLE IF NOT EXISTS backfill_queue (
      wallet TEXT PRIMARY KEY,
      priority INTEGER DEFAULT 0,
      created_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    );

    -- Indexes for fast queries
    CREATE INDEX IF NOT EXISTS idx_trades_wallet_time ON trades(wallet, timestamp);
    CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_redemptions_wallet ON redemptions(wallet);
  `);

  // Record schema version if not exists
  const existing = db
    .prepare('SELECT version FROM schema_version WHERE version = ?')
    .get(SCHEMA_VERSION);

  if (!existing) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }
}
