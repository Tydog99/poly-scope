import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, SCHEMA_VERSION } from '../../src/db/schema.js';
import { unlinkSync, existsSync } from 'fs';

describe('Database Schema', () => {
  const testDbPath = '.data/test-schema.db';
  let db: Database.Database;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    db = new Database(testDbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
  });

  it('creates all required tables', () => {
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('trades');
    expect(tableNames).toContain('accounts');
    expect(tableNames).toContain('redemptions');
    expect(tableNames).toContain('markets');
    expect(tableNames).toContain('backfill_queue');
    expect(tableNames).toContain('schema_version');
  });

  it('creates required indexes', () => {
    initializeSchema(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];

    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_trades_wallet_time');
    expect(indexNames).toContain('idx_trades_market');
    expect(indexNames).toContain('idx_redemptions_wallet');
  });

  it('sets WAL mode for better concurrency', () => {
    initializeSchema(db);

    const result = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe('wal');
  });

  it('tracks schema version', () => {
    initializeSchema(db);

    const version = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number };

    expect(version.version).toBe(SCHEMA_VERSION);
  });

  it('is idempotent - running twice does not error', () => {
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
  });

  it('creates markets table with sync columns', () => {
    initializeSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(markets)")
      .all() as { name: string }[];

    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('token_id');
    expect(columnNames).toContain('condition_id');
    expect(columnNames).toContain('question');
    expect(columnNames).toContain('outcome');
    expect(columnNames).toContain('synced_from');
    expect(columnNames).toContain('synced_to');
    expect(columnNames).toContain('synced_at');
    expect(columnNames).toContain('has_complete_history');
  });

  it('migrates existing DB without sync columns', () => {
    // Create v1 schema without sync columns
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      INSERT INTO schema_version (version) VALUES (1);

      CREATE TABLE IF NOT EXISTS markets (
        token_id TEXT PRIMARY KEY,
        condition_id TEXT,
        question TEXT,
        outcome TEXT,
        outcome_index INTEGER,
        resolved_at INTEGER
      );
    `);

    // Run migration
    initializeSchema(db);

    // Verify sync columns were added
    const columns = db
      .prepare("PRAGMA table_info(markets)")
      .all() as { name: string }[];

    const columnNames = columns.map(c => c.name);
    expect(columnNames).toContain('synced_from');
    expect(columnNames).toContain('synced_to');
    expect(columnNames).toContain('synced_at');
    expect(columnNames).toContain('has_complete_history');

    // Verify schema version was updated
    const version = db
      .prepare('SELECT MAX(version) as version FROM schema_version')
      .get() as { version: number };
    expect(version.version).toBe(SCHEMA_VERSION);
  });
});
