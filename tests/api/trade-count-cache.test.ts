import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeCountCache, type TradeCountData } from '../../src/api/trade-count-cache.js';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_CACHE_DIR = '.cache/test-trade-counts';

describe('TradeCountCache', () => {
  let cache: TradeCountCache;

  beforeEach(() => {
    // Clean up test cache dir
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    cache = new TradeCountCache(TEST_CACHE_DIR);
  });

  afterEach(() => {
    // Clean up after tests
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  describe('save and load', () => {
    it('saves and loads trade count data', () => {
      const wallet = '0xABC123';
      const data: TradeCountData = {
        count: 42,
        firstTimestamp: 1700000000,
        lastTimestamp: 1700100000,
      };

      cache.save(wallet, data);
      const loaded = cache.load(wallet);

      expect(loaded).toEqual(data);
    });

    it('normalizes wallet addresses to lowercase', () => {
      const data: TradeCountData = {
        count: 10,
        firstTimestamp: 1700000000,
        lastTimestamp: 1700100000,
      };

      cache.save('0xABC', data);

      // Should be able to load with different case
      expect(cache.load('0xabc')).toEqual(data);
      expect(cache.load('0xABC')).toEqual(data);
      expect(cache.has('0xAbC')).toBe(true);
    });

    it('returns null for non-existent wallet', () => {
      expect(cache.load('0xnonexistent')).toBeNull();
    });
  });

  describe('has', () => {
    it('returns true for cached wallet', () => {
      cache.save('0xabc', { count: 1, firstTimestamp: 0, lastTimestamp: 0 });
      expect(cache.has('0xabc')).toBe(true);
    });

    it('returns false for non-cached wallet', () => {
      expect(cache.has('0xnonexistent')).toBe(false);
    });
  });

  describe('loadBatch', () => {
    it('separates cached and uncached wallets', () => {
      // Save some data
      cache.save('0xaaa', { count: 1, firstTimestamp: 100, lastTimestamp: 100 });
      cache.save('0xbbb', { count: 2, firstTimestamp: 200, lastTimestamp: 200 });

      const { cached, uncached } = cache.loadBatch(['0xaaa', '0xbbb', '0xccc', '0xddd']);

      expect(cached.size).toBe(2);
      expect(cached.get('0xaaa')?.count).toBe(1);
      expect(cached.get('0xbbb')?.count).toBe(2);
      expect(uncached).toEqual(['0xccc', '0xddd']);
    });

    it('returns all uncached for empty cache', () => {
      const { cached, uncached } = cache.loadBatch(['0xaaa', '0xbbb']);

      expect(cached.size).toBe(0);
      expect(uncached).toEqual(['0xaaa', '0xbbb']);
    });

    it('returns all cached when all exist', () => {
      cache.save('0xaaa', { count: 1, firstTimestamp: 100, lastTimestamp: 100 });
      cache.save('0xbbb', { count: 2, firstTimestamp: 200, lastTimestamp: 200 });

      const { cached, uncached } = cache.loadBatch(['0xaaa', '0xbbb']);

      expect(cached.size).toBe(2);
      expect(uncached).toEqual([]);
    });
  });

  describe('saveBatch', () => {
    it('saves multiple wallets at once', () => {
      const batch = new Map<string, TradeCountData>([
        ['0xaaa', { count: 10, firstTimestamp: 1000, lastTimestamp: 2000 }],
        ['0xbbb', { count: 20, firstTimestamp: 1500, lastTimestamp: 2500 }],
        ['0xccc', { count: 30, firstTimestamp: 1800, lastTimestamp: 2800 }],
      ]);

      cache.saveBatch(batch);

      expect(cache.load('0xaaa')?.count).toBe(10);
      expect(cache.load('0xbbb')?.count).toBe(20);
      expect(cache.load('0xccc')?.count).toBe(30);
    });
  });

  describe('incremental caching workflow', () => {
    it('supports incremental saves and partial retries', () => {
      // Simulate first run - save batches 1 and 2, then "fail"
      cache.save('0x001', { count: 1, firstTimestamp: 100, lastTimestamp: 100 });
      cache.save('0x002', { count: 2, firstTimestamp: 200, lastTimestamp: 200 });
      // "crash" before batch 3

      // Simulate retry - should only need to fetch 0x003 and 0x004
      const { cached, uncached } = cache.loadBatch(['0x001', '0x002', '0x003', '0x004']);

      expect(cached.size).toBe(2);
      expect(uncached).toEqual(['0x003', '0x004']);

      // Complete the remaining batches
      cache.save('0x003', { count: 3, firstTimestamp: 300, lastTimestamp: 300 });
      cache.save('0x004', { count: 4, firstTimestamp: 400, lastTimestamp: 400 });

      // Verify all data is now cached
      const { cached: allCached, uncached: noneUncached } = cache.loadBatch([
        '0x001', '0x002', '0x003', '0x004'
      ]);

      expect(allCached.size).toBe(4);
      expect(noneUncached).toEqual([]);
    });
  });
});
