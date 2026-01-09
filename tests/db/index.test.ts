import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeDB } from '../../src/db/index.js';
import { unlinkSync, existsSync, rmSync } from 'fs';

describe('TradeDB', () => {
  const testDbPath = '.data/test-tradedb.db';
  let tradeDb: TradeDB;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    tradeDb = new TradeDB(testDbPath);
  });

  afterEach(() => {
    tradeDb.close();
    // Clean up WAL files too
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
  });

  describe('initialization', () => {
    it('creates database file', () => {
      expect(existsSync(testDbPath)).toBe(true);
    });

    it('creates .data directory if not exists', () => {
      const nestedPath = '.data/nested/test.db';
      const db = new TradeDB(nestedPath);
      expect(existsSync(nestedPath)).toBe(true);
      db.close();
      rmSync('.data/nested', { recursive: true });
    });
  });

  describe('status', () => {
    it('returns database statistics', () => {
      const status = tradeDb.getStatus();

      expect(status).toEqual({
        path: testDbPath,
        trades: 0,
        accounts: 0,
        redemptions: 0,
        markets: 0,
        backfillQueue: 0,
      });
    });
  });
});
