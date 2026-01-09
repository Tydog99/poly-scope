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
});
