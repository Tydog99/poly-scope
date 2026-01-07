import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RedemptionCache } from '../../src/api/redemption-cache.js';
import type { SubgraphRedemption } from '../../src/api/types.js';
import { rmSync, existsSync } from 'fs';

const TEST_CACHE_DIR = '.cache/test-redemptions';

describe('RedemptionCache', () => {
  let cache: RedemptionCache;

  beforeEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    cache = new RedemptionCache(TEST_CACHE_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  const makeRedemption = (id: string, payout: string): SubgraphRedemption => ({
    id,
    timestamp: 1700000000,
    payout,
    conditionId: 'condition-123',
  });

  describe('save and load', () => {
    it('saves and loads redemption data', () => {
      const wallet = '0xABC123';
      const redemptions: SubgraphRedemption[] = [
        makeRedemption('r1', '1000000'),
        makeRedemption('r2', '2000000'),
      ];

      cache.save(wallet, redemptions);
      const loaded = cache.load(wallet);

      expect(loaded).toEqual(redemptions);
    });

    it('normalizes wallet addresses to lowercase', () => {
      const redemptions = [makeRedemption('r1', '1000')];

      cache.save('0xABC', redemptions);

      expect(cache.load('0xabc')).toEqual(redemptions);
      expect(cache.has('0xAbC')).toBe(true);
    });

    it('returns null for non-existent wallet', () => {
      expect(cache.load('0xnonexistent')).toBeNull();
    });

    it('handles empty redemption arrays', () => {
      cache.save('0xabc', []);
      expect(cache.load('0xabc')).toEqual([]);
    });
  });

  describe('loadBatch', () => {
    it('separates cached and uncached wallets', () => {
      cache.save('0xaaa', [makeRedemption('r1', '100')]);
      cache.save('0xbbb', [makeRedemption('r2', '200')]);

      const { cached, uncached } = cache.loadBatch(['0xaaa', '0xbbb', '0xccc']);

      expect(cached.size).toBe(2);
      expect(cached.get('0xaaa')).toHaveLength(1);
      expect(cached.get('0xbbb')).toHaveLength(1);
      expect(uncached).toEqual(['0xccc']);
    });

    it('handles wallets with no redemptions (empty array)', () => {
      cache.save('0xaaa', []); // Wallet with no redemptions
      cache.save('0xbbb', [makeRedemption('r1', '100')]);

      const { cached, uncached } = cache.loadBatch(['0xaaa', '0xbbb', '0xccc']);

      expect(cached.size).toBe(2);
      expect(cached.get('0xaaa')).toEqual([]);
      expect(uncached).toEqual(['0xccc']);
    });
  });

  describe('saveBatch', () => {
    it('saves multiple wallets at once', () => {
      const batch = new Map<string, SubgraphRedemption[]>([
        ['0xaaa', [makeRedemption('r1', '100')]],
        ['0xbbb', [makeRedemption('r2', '200'), makeRedemption('r3', '300')]],
        ['0xccc', []],
      ]);

      cache.saveBatch(batch);

      expect(cache.load('0xaaa')).toHaveLength(1);
      expect(cache.load('0xbbb')).toHaveLength(2);
      expect(cache.load('0xccc')).toEqual([]);
    });
  });
});
