import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DBAccountFetcher } from '../../src/api/db-accounts.js';
import { TradeDB } from '../../src/db/index.js';
import { unlinkSync, existsSync } from 'fs';

describe('DBAccountFetcher', () => {
  const testDbPath = '.data/test-db-accounts.db';
  let db: TradeDB;
  let fetcher: DBAccountFetcher;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    db = new TradeDB(testDbPath);
    fetcher = new DBAccountFetcher({ db });
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
  });

  describe('getFromDB', () => {
    it('returns cached account when fresh', () => {
      db.saveAccount({
        wallet: '0x123',
        creationTimestamp: 1704067200,
        syncedFrom: 1704067200,
        syncedTo: Math.floor(Date.now() / 1000), // Fresh
        syncedAt: Math.floor(Date.now() / 1000),
        tradeCountTotal: 100,
        collateralVolume: 1000000000,
        profit: 50000000,
        hasFullHistory: true,
      });

      const result = fetcher.getFromDB('0x123');

      expect(result).not.toBeNull();
      expect(result!.wallet).toBe('0x123');
      expect(result!.totalTrades).toBe(100);
      expect(result!.totalVolumeUsd).toBe(1000); // 1000000000 / 1e6
      expect(result!.profitUsd).toBe(50); // 50000000 / 1e6
      expect(result!.dataSource).toBe('cache');
    });

    it('returns null when account not in DB', () => {
      expect(fetcher.getFromDB('0xnonexistent')).toBeNull();
    });

    it('converts timestamps to Date objects', () => {
      db.saveAccount({
        wallet: '0x123',
        creationTimestamp: 1704067200,
        syncedFrom: 1704153600,
        syncedTo: 1704240000,
        syncedAt: Math.floor(Date.now() / 1000),
        tradeCountTotal: 50,
        collateralVolume: 500000000,
        profit: null,
        hasFullHistory: true,
      });

      const result = fetcher.getFromDB('0x123');

      expect(result!.creationDate).toEqual(new Date(1704067200 * 1000));
      expect(result!.firstTradeDate).toEqual(new Date(1704153600 * 1000));
      expect(result!.lastTradeDate).toEqual(new Date(1704240000 * 1000));
    });

    it('handles null timestamps gracefully', () => {
      db.saveAccount({
        wallet: '0x123',
        creationTimestamp: null,
        syncedFrom: null,
        syncedTo: null,
        syncedAt: Math.floor(Date.now() / 1000),
        tradeCountTotal: 0,
        collateralVolume: null,
        profit: null,
        hasFullHistory: false,
      });

      const result = fetcher.getFromDB('0x123');

      expect(result!.creationDate).toBeUndefined();
      expect(result!.firstTradeDate).toBeNull();
      expect(result!.lastTradeDate).toBeNull();
      expect(result!.totalVolumeUsd).toBe(0);
      expect(result!.profitUsd).toBeUndefined();
    });
  });

  describe('isStale', () => {
    it('detects stale accounts', () => {
      db.saveAccount({
        wallet: '0x123',
        creationTimestamp: 1704067200,
        syncedFrom: 1704067200,
        syncedTo: 1704067200, // Old timestamp
        syncedAt: 1704067200, // Synced long ago
        tradeCountTotal: 100,
        collateralVolume: 1000000000,
        profit: 50000000,
        hasFullHistory: true,
      });

      expect(fetcher.isStale('0x123')).toBe(true);
    });

    it('returns true for non-existent accounts', () => {
      expect(fetcher.isStale('0xnonexistent')).toBe(true);
    });

    it('returns false for recently synced accounts', () => {
      db.saveAccount({
        wallet: '0x123',
        creationTimestamp: 1704067200,
        syncedFrom: 1704067200,
        syncedTo: Math.floor(Date.now() / 1000),
        syncedAt: Math.floor(Date.now() / 1000), // Just synced
        tradeCountTotal: 100,
        collateralVolume: 1000000000,
        profit: 50000000,
        hasFullHistory: true,
      });

      expect(fetcher.isStale('0x123')).toBe(false);
    });

    it('respects custom stale duration', () => {
      const customFetcher = new DBAccountFetcher({
        db,
        staleDurationMs: 1000, // 1 second
      });

      db.saveAccount({
        wallet: '0x123',
        creationTimestamp: 1704067200,
        syncedFrom: 1704067200,
        syncedTo: Math.floor(Date.now() / 1000),
        syncedAt: Math.floor(Date.now() / 1000) - 2, // 2 seconds ago
        tradeCountTotal: 100,
        collateralVolume: 1000000000,
        profit: 50000000,
        hasFullHistory: true,
      });

      expect(customFetcher.isStale('0x123')).toBe(true);
    });
  });

  describe('saveToDBFromSubgraph', () => {
    it('saves account history to database', () => {
      const history = {
        wallet: '0x456',
        totalTrades: 200,
        firstTradeDate: new Date(1704067200 * 1000),
        lastTradeDate: new Date(1704153600 * 1000),
        totalVolumeUsd: 5000,
        creationDate: new Date(1704000000 * 1000),
        profitUsd: 250,
        dataSource: 'subgraph' as const,
      };

      fetcher.saveToDBFromSubgraph(history);

      const saved = db.getAccount('0x456');
      expect(saved).not.toBeNull();
      expect(saved!.wallet).toBe('0x456');
      expect(saved!.tradeCountTotal).toBe(200);
      expect(saved!.collateralVolume).toBe(5000000000); // 5000 * 1e6
      expect(saved!.profit).toBe(250000000); // 250 * 1e6
      expect(saved!.creationTimestamp).toBe(1704000000);
      expect(saved!.syncedFrom).toBe(1704067200);
      expect(saved!.syncedTo).toBe(1704153600);
    });

    it('handles null dates gracefully', () => {
      const history = {
        wallet: '0x789',
        totalTrades: 0,
        firstTradeDate: null,
        lastTradeDate: null,
        totalVolumeUsd: 0,
        dataSource: 'subgraph' as const,
      };

      fetcher.saveToDBFromSubgraph(history);

      const saved = db.getAccount('0x789');
      expect(saved).not.toBeNull();
      expect(saved!.syncedFrom).toBeNull();
      // syncedTo should be set to now when lastTradeDate is null
      expect(saved!.syncedTo).toBeGreaterThan(0);
    });

    it('sets syncedAt to current time', () => {
      const beforeSave = Math.floor(Date.now() / 1000);

      fetcher.saveToDBFromSubgraph({
        wallet: '0xabc',
        totalTrades: 10,
        firstTradeDate: new Date(),
        lastTradeDate: new Date(),
        totalVolumeUsd: 100,
        dataSource: 'subgraph' as const,
      });

      const afterSave = Math.floor(Date.now() / 1000);
      const saved = db.getAccount('0xabc');

      expect(saved!.syncedAt).toBeGreaterThanOrEqual(beforeSave);
      expect(saved!.syncedAt).toBeLessThanOrEqual(afterSave);
    });
  });
});
