import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountFetcher } from '../../src/api/accounts.js';
import { SubgraphClient } from '../../src/api/subgraph.js';
// The import is unused here but necessary for mocking
import { AccountCache } from '../../src/api/account-cache.js';

// Mock AccountCache
const mockLoad = vi.fn();
const mockSave = vi.fn();

vi.mock('../../src/api/account-cache.js', () => ({
  AccountCache: class {
    load = mockLoad;
    save = mockSave;
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AccountFetcher', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.clearAllMocks();
    mockLoad.mockReset();
    mockSave.mockReset();
  });

  describe('without subgraph', () => {
    it('fetches account history from Data API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { proxyWallet: '0xwallet', timestamp: 1704067200000, size: '100', price: '0.5' },
            { proxyWallet: '0xwallet', timestamp: 1705276800000, size: '200', price: '0.3' },
          ]),
      });

      const fetcher = new AccountFetcher();
      const history = await fetcher.getAccountHistory('0xwallet');

      expect(history.wallet).toBe('0xwallet');
      expect(history.totalTrades).toBe(2);
      expect(history.totalVolumeUsd).toBe(110);
      expect(history.dataSource).toBe('data-api');
    });

    it('handles accounts with no trades', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const fetcher = new AccountFetcher();
      const history = await fetcher.getAccountHistory('0xnewbie');

      expect(history.totalTrades).toBe(0);
      expect(history.firstTradeDate).toBeNull();
      expect(history.lastTradeDate).toBeNull();
      expect(history.dataSource).toBe('data-api');
    });
  });

  describe('with subgraph', () => {
    // ... existing subgraph tests ...
    it('uses subgraph data when available', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              account: {
                id: '0xwallet',
                creationTimestamp: '1735275941',
                lastSeenTimestamp: '1735948831',
                collateralVolume: '404357630000',
                numTrades: '268',
                profit: '-28076440000',
                scaledProfit: '-28076.44',
              },
            },
          }),
      });

      const subgraphClient = new SubgraphClient('test-key');
      const fetcher = new AccountFetcher({ subgraphClient });
      const history = await fetcher.getAccountHistory('0xwallet');

      expect(history.dataSource).toBe('subgraph');
    });

    it('falls back to Data API when account not found in subgraph', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { account: null } }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { proxyWallet: '0xnewwallet', timestamp: 1704067200000, size: '50', price: '0.5' },
          ]),
      });

      const subgraphClient = new SubgraphClient('test-key');
      const fetcher = new AccountFetcher({ subgraphClient });
      const history = await fetcher.getAccountHistory('0xnewwallet');

      expect(history.dataSource).toBe('data-api');
    });
  });

  describe('caching', () => {
    it('uses cache when enabled and hit occurs', async () => {
      const cachedHistory = {
        wallet: '0xcached',
        totalTrades: 5,
        dataSource: 'subgraph',
      };
      mockLoad.mockReturnValue(cachedHistory);

      const fetcher = new AccountFetcher({ cacheAccountLookup: true });
      const history = await fetcher.getAccountHistory('0xcached');

      expect(mockLoad).toHaveBeenCalledWith('0xcached');
      expect(history).toEqual({ ...cachedHistory, dataSource: 'cache' });
      expect(mockFetch).not.toHaveBeenCalled(); // Should not fetch from network
    });

    it('fetches and saves when enabled and cache miss', async () => {
      mockLoad.mockReturnValue(null); // Cache miss
      mockFetch.mockResolvedValueOnce({ // API response
        ok: true,
        json: () => Promise.resolve([]),
      });

      const fetcher = new AccountFetcher({ cacheAccountLookup: true });
      const history = await fetcher.getAccountHistory('0xmiss');

      expect(mockLoad).toHaveBeenCalledWith('0xmiss');
      expect(mockFetch).toHaveBeenCalled();
      expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ wallet: '0xmiss' }));
    });

    it('ignores cache when disabled (default)', async () => {
      mockLoad.mockReturnValue({ wallet: '0xignored' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const fetcher = new AccountFetcher({ cacheAccountLookup: false });
      await fetcher.getAccountHistory('0xignored');

      expect(mockLoad).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('batch fetch uses cache for hits and fetches misses', async () => {
      const cached = { wallet: '0xhit', totalTrades: 1 };
      mockLoad.mockImplementation((w: string) => w === '0xhit' ? cached : null);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ proxyWallet: '0xmiss', timestamp: 0, size: 0, price: 0 }])
      });

      const fetcher = new AccountFetcher({ cacheAccountLookup: true });
      const results = await fetcher.getAccountHistoryBatch(['0xhit', '0xmiss']);

      expect(results.get('0xhit')).toEqual({ ...cached, dataSource: 'cache' });
      expect(results.get('0xmiss')).toBeDefined();

      // Should save the missing wallet after fetching
      expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ wallet: '0xmiss' }));
      // Should NOT save the hit wallet (optimization)
      expect(mockSave).not.toHaveBeenCalledWith(cached);
    });
  });
});
