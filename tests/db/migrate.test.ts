import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradeDB } from '../../src/db/index.js';
import { importJsonCaches, validateMigration, MigrationResult } from '../../src/db/migrate.js';
import { unlinkSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';

describe('Migration', () => {
  const testDbPath = '.data/test-migrate.db';
  const testCacheDir = '.test-cache';
  let db: TradeDB;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(testCacheDir)) rmSync(testCacheDir, { recursive: true });
    db = new TradeDB(testDbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
    if (existsSync(testCacheDir)) rmSync(testCacheDir, { recursive: true });
  });

  describe('importJsonCaches', () => {
    it('imports trades from JSON cache files', () => {
      mkdirSync(`${testCacheDir}/trades`, { recursive: true });
      writeFileSync(`${testCacheDir}/trades/market-123.json`, JSON.stringify({
        marketId: 'market-123',
        trades: [
          { transactionHash: 'tx1', wallet: '0x123', marketId: 'token-1', timestamp: '2024-01-01T00:00:00.000Z',
            side: 'Buy', action: 'BUY', role: 'taker', totalSize: 100, avgPrice: 0.5, totalValueUsd: 50,
            fills: [{ id: 'fill-1', size: 100, price: 0.5, valueUsd: 50, timestamp: '2024-01-01T00:00:00.000Z' }] },
        ],
      }));

      const result = importJsonCaches(db, testCacheDir);

      expect(result.trades).toBe(1);
      expect(db.getStatus().trades).toBe(1);
    });

    it('imports accounts from JSON cache files', () => {
      mkdirSync(`${testCacheDir}/accounts`, { recursive: true });
      writeFileSync(`${testCacheDir}/accounts/0x123.json`, JSON.stringify({
        wallet: '0x123', totalTrades: 10, totalVolumeUsd: 1000,
        firstTradeDate: '2024-01-01T00:00:00.000Z', lastTradeDate: '2024-01-02T00:00:00.000Z',
        creationDate: '2023-12-31T00:00:00.000Z', profitUsd: 50,
      }));

      const result = importJsonCaches(db, testCacheDir);

      expect(result.accounts).toBe(1);
      expect(db.getAccount('0x123')).not.toBeNull();
    });

    it('is idempotent - running twice imports once', () => {
      mkdirSync(`${testCacheDir}/accounts`, { recursive: true });
      writeFileSync(`${testCacheDir}/accounts/0x123.json`, JSON.stringify({
        wallet: '0x123', totalTrades: 10, totalVolumeUsd: 1000,
        firstTradeDate: null, lastTradeDate: null,
      }));

      importJsonCaches(db, testCacheDir);
      const result = importJsonCaches(db, testCacheDir);

      expect(result.accounts).toBe(0); // Already imported
    });
  });

  describe('validateMigration', () => {
    it('returns valid when counts match', () => {
      mkdirSync(`${testCacheDir}/accounts`, { recursive: true });
      writeFileSync(`${testCacheDir}/accounts/0x123.json`, JSON.stringify({
        wallet: '0x123', totalTrades: 10, totalVolumeUsd: 1000,
        firstTradeDate: null, lastTradeDate: null,
      }));

      importJsonCaches(db, testCacheDir);
      const validation = validateMigration(db, testCacheDir);

      expect(validation.valid).toBe(true);
      expect(validation.dbCounts.accounts).toBe(1);
      expect(validation.jsonCounts.accounts).toBe(1);
    });

    it('returns invalid when DB has fewer records', () => {
      mkdirSync(`${testCacheDir}/accounts`, { recursive: true });
      writeFileSync(`${testCacheDir}/accounts/0x123.json`, JSON.stringify({
        wallet: '0x123', totalTrades: 10, totalVolumeUsd: 1000,
        firstTradeDate: null, lastTradeDate: null,
      }));

      // Don't import - DB is empty
      const validation = validateMigration(db, testCacheDir);

      expect(validation.valid).toBe(false);
    });
  });
});
