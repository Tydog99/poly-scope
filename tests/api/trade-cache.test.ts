import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeCacheChecker } from '../../src/api/trade-cache.js';
import { TradeDB } from '../../src/db/index.js';
import { unlinkSync, existsSync } from 'fs';

describe('TradeCacheChecker', () => {
  const testDbPath = '.data/test-trade-cache.db';
  let db: TradeDB;
  let checker: TradeCacheChecker;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    db = new TradeDB(testDbPath);
    checker = new TradeCacheChecker(db, { staleDurationSeconds: 3600 }); // 1 hour
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
  });

  const mockMarket = {
    tokenId: 'token-123',
    conditionId: 'cond-456',
    question: 'Test market?',
    outcome: 'Yes',
    outcomeIndex: 0,
    resolvedAt: null,
  };

  describe('isFresh', () => {
    it('returns false for null syncedAt', () => {
      expect(checker.isFresh(null)).toBe(false);
    });

    it('returns true for recent syncedAt', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(checker.isFresh(now - 1800)).toBe(true); // 30 minutes ago
    });

    it('returns false for old syncedAt', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(checker.isFresh(now - 7200)).toBe(false); // 2 hours ago
    });
  });

  describe('checkCoverage', () => {
    it('returns missing for non-existent market', () => {
      const result = checker.checkCoverage('nonexistent');

      expect(result.sync).toBeNull();
      expect(result.needsFetch.reason).toBe('missing');
    });

    it('returns missing for market with null syncedAt', () => {
      db.saveMarkets([mockMarket]);

      const result = checker.checkCoverage('token-123');

      expect(result.needsFetch.reason).toBe('missing');
    });

    it('returns stale for old sync', () => {
      db.saveMarkets([mockMarket]);
      const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
      db.updateMarketSync('token-123', {
        syncedFrom: 1000,
        syncedTo: 5000,
      });
      // Manually set syncedAt to old value
      // Note: updateMarketSync sets syncedAt to now, so we need to update it manually
      // For this test, we'll use a fresh checker with very short TTL
      const shortChecker = new TradeCacheChecker(db, { staleDurationSeconds: 0 });

      const result = shortChecker.checkCoverage('token-123');

      expect(result.needsFetch.reason).toBe('stale');
      expect(result.needsFetch.after).toBe(5000);
    });

    it('returns none for fresh and complete coverage', () => {
      db.saveMarkets([mockMarket]);
      db.updateMarketSync('token-123', {
        syncedFrom: 1000,
        syncedTo: 5000,
        hasCompleteHistory: true,
      });

      const result = checker.checkCoverage('token-123', { after: 2000, before: 4000 });

      expect(result.needsFetch.reason).toBe('none');
    });

    it('returns partial-older when requesting older data without complete history', () => {
      db.saveMarkets([mockMarket]);
      db.updateMarketSync('token-123', {
        syncedFrom: 3000,
        syncedTo: 5000,
        hasCompleteHistory: false,
      });

      const result = checker.checkCoverage('token-123', { after: 1000 });

      expect(result.needsFetch.reason).toBe('partial-older');
      expect(result.needsFetch.before).toBe(3000);
      expect(result.needsFetch.after).toBe(1000);
    });

    it('returns none when requesting older data with complete history', () => {
      db.saveMarkets([mockMarket]);
      db.updateMarketSync('token-123', {
        syncedFrom: 3000,
        syncedTo: 5000,
        hasCompleteHistory: true,
      });

      const result = checker.checkCoverage('token-123', { after: 1000 });

      // Complete history means we have all data, even if syncedFrom > requested after
      expect(result.needsFetch.reason).toBe('none');
    });

    it('returns partial-newer when requesting newer data than cached', () => {
      db.saveMarkets([mockMarket]);
      db.updateMarketSync('token-123', {
        syncedFrom: 1000,
        syncedTo: 3000,
      });

      const result = checker.checkCoverage('token-123', { before: 5000 });

      expect(result.needsFetch.reason).toBe('partial-newer');
      expect(result.needsFetch.after).toBe(3000);
      expect(result.needsFetch.before).toBe(5000);
    });

    it('returns none when requested range is within cached range', () => {
      db.saveMarkets([mockMarket]);
      db.updateMarketSync('token-123', {
        syncedFrom: 1000,
        syncedTo: 5000,
      });

      const result = checker.checkCoverage('token-123', { after: 2000, before: 4000 });

      expect(result.needsFetch.reason).toBe('none');
    });

    it('handles no range specified', () => {
      db.saveMarkets([mockMarket]);
      db.updateMarketSync('token-123', {
        syncedFrom: 1000,
        syncedTo: 5000,
      });

      const result = checker.checkCoverage('token-123');

      // Fresh and no specific range requested
      expect(result.needsFetch.reason).toBe('none');
    });
  });

  describe('with custom stale duration', () => {
    it('respects custom stale duration', () => {
      const shortChecker = new TradeCacheChecker(db, { staleDurationSeconds: 60 }); // 1 minute

      db.saveMarkets([mockMarket]);
      db.updateMarketSync('token-123', {
        syncedFrom: 1000,
        syncedTo: 5000,
      });

      // Should be fresh immediately after update
      const result1 = shortChecker.checkCoverage('token-123');
      expect(result1.needsFetch.reason).toBe('none');

      // With 0 second TTL, should be stale
      const instantStaleChecker = new TradeCacheChecker(db, { staleDurationSeconds: 0 });
      const result2 = instantStaleChecker.checkCoverage('token-123');
      expect(result2.needsFetch.reason).toBe('stale');
    });
  });
});
