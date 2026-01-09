import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountFetcher } from '../../src/api/accounts.js';
import { SubgraphClient } from '../../src/api/subgraph.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AccountFetcher', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.clearAllMocks();
  });

  describe('without subgraph', () => {
    it('fetches account history from Data API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { proxyWallet: '0xwallet', timestamp: 1704067200, size: '100', price: '0.5' },
            { proxyWallet: '0xwallet', timestamp: 1705276800, size: '200', price: '0.3' },
          ]),
      });

      const fetcher = new AccountFetcher();
      const history = await fetcher.getAccountHistory('0xwallet');

      expect(history!.wallet).toBe('0xwallet');
      expect(history!.totalTrades).toBe(2);
      expect(history!.totalVolumeUsd).toBe(110);
      expect(history!.dataSource).toBe('data-api');

      // Jan 1st 2024
      expect(history!.firstTradeDate?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
      expect(history!.lastTradeDate?.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('handles accounts with no trades', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const fetcher = new AccountFetcher();
      const history = await fetcher.getAccountHistory('0xnewbie');

      expect(history!.totalTrades).toBe(0);
      expect(history!.firstTradeDate).toBeNull();
      expect(history!.lastTradeDate).toBeNull();
      expect(history!.dataSource).toBe('data-api');
    });
  });

  describe('with subgraph', () => {
    it('uses subgraph data when available', async () => {
      // Mock account query
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

      // Mock redemptions query (called in parallel)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              redemptions: [
                { id: 'r1', timestamp: '1735948831', payout: '437957000000', condition: { id: '0xcond1' } },
              ],
            },
          }),
      });

      const subgraphClient = new SubgraphClient('test-key');
      const fetcher = new AccountFetcher({ subgraphClient });
      const history = await fetcher.getAccountHistory('0xwallet');

      expect(history!.dataSource).toBe('subgraph');
      expect(history!.profitUsd).toBeCloseTo(409880.56, 0); // trading + redemptions
      expect(history!.tradingProfitUsd).toBeCloseTo(-28076.44, 0);
      expect(history!.redemptionPayoutsUsd).toBeCloseTo(437957, 0);
    });

    it('falls back to Data API when account not found in subgraph', async () => {
      // Mock account query - returns null
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { account: null } }),
      });

      // Mock redemptions query (called in parallel, will be ignored)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { redemptions: [] } }),
      });

      // Mock Data API fallback
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { proxyWallet: '0xnewwallet', timestamp: 1704067200, size: '50', price: '0.5' },
          ]),
      });

      const subgraphClient = new SubgraphClient('test-key');
      const fetcher = new AccountFetcher({ subgraphClient });
      const history = await fetcher.getAccountHistory('0xnewwallet');

      expect(history!.dataSource).toBe('data-api');
    });
  });
});
