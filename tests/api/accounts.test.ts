import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountFetcher } from '../../src/api/accounts.js';
import { SubgraphClient } from '../../src/api/subgraph.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AccountFetcher', () => {
  beforeEach(() => {
    mockFetch.mockReset();
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

    it('calculates first and last trade dates', async () => {
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

      expect(history.firstTradeDate?.getTime()).toBe(1704067200000);
      expect(history.lastTradeDate?.getTime()).toBe(1705276800000);
    });
  });

  describe('with subgraph', () => {
    it('uses subgraph data when available', async () => {
      // Mock subgraph response
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

      expect(history.wallet).toBe('0xwallet');
      expect(history.totalTrades).toBe(268);
      expect(history.totalVolumeUsd).toBeCloseTo(404357.63, 1);
      expect(history.profitUsd).toBeCloseTo(-28076.44, 1);
      expect(history.dataSource).toBe('subgraph');
      expect(history.creationDate).toBeDefined();
    });

    it('falls back to Data API when subgraph fails', async () => {
      // Mock subgraph error (will be called up to 3 times due to retries)
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errors: [{ message: 'Subgraph error' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errors: [{ message: 'Subgraph error' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ errors: [{ message: 'Subgraph error' }] }),
        })
        // Mock Data API response (after subgraph exhausts retries)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              { proxyWallet: '0xwallet', timestamp: 1704067200000, size: '100', price: '0.5' },
            ]),
        });

      const subgraphClient = new SubgraphClient('test-key', { retries: 2 });
      const fetcher = new AccountFetcher({ subgraphClient });
      const history = await fetcher.getAccountHistory('0xwallet');

      expect(history.dataSource).toBe('data-api');
      expect(history.totalTrades).toBe(1);
    });

    it('falls back to Data API when account not found in subgraph', async () => {
      // Mock subgraph returns null account
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { account: null },
          }),
      });

      // Mock Data API response
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
});
