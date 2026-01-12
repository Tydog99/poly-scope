import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PriceFetcher } from '../../src/api/prices.js';
import type { TradeDB, DBPricePoint, PriceSyncStatus } from '../../src/db/index.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Suppress console.warn in tests
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('PriceFetcher', () => {
  let fetcher: PriceFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new PriceFetcher();
  });

  describe('fetchFromApi', () => {
    it('fetches prices from CLOB API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          history: [
            { t: 1000, p: 0.5 },
            { t: 1060, p: 0.52 },
          ],
        }),
      });

      const prices = await fetcher.fetchFromApi('token-123', 900, 1100);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('clob.polymarket.com/prices-history')
      );
      expect(prices).toHaveLength(2);
      expect(prices[0]).toEqual({ timestamp: 1000, price: 0.5 });
    });

    it('includes query parameters in URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ history: [] }),
      });

      await fetcher.fetchFromApi('token-xyz', 1000, 2000);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('market=token-xyz');
      expect(calledUrl).toContain('startTs=1000');
      expect(calledUrl).toContain('endTs=2000');
    });

    it('returns empty array on API error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const prices = await fetcher.fetchFromApi('token-123', 900, 1100);
      expect(prices).toEqual([]);
    });

    it('returns empty array on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const prices = await fetcher.fetchFromApi('token-123', 900, 1100);
      expect(prices).toEqual([]);
    });
  });

  describe('getPricesForToken', () => {
    it('fetches from API when no DB provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ history: [{ t: 1000, p: 0.5 }] }),
      });

      const prices = await fetcher.getPricesForToken('token-123', 900, 1100);
      expect(prices).toHaveLength(1);
    });

    describe('with DB caching', () => {
      let mockDb: {
        getPriceSyncStatus: ReturnType<typeof vi.fn>;
        getPricesForToken: ReturnType<typeof vi.fn>;
        savePrices: ReturnType<typeof vi.fn>;
      };

      beforeEach(() => {
        mockDb = {
          getPriceSyncStatus: vi.fn(),
          getPricesForToken: vi.fn(),
          savePrices: vi.fn(),
        };
      });

      it('returns cached data when DB has full coverage', async () => {
        const cachedPrices: DBPricePoint[] = [
          { timestamp: 950, price: 0.48 },
          { timestamp: 1000, price: 0.5 },
          { timestamp: 1050, price: 0.51 },
        ];

        mockDb.getPriceSyncStatus.mockReturnValue({
          syncedFrom: 900,
          syncedTo: 1100,
        } as PriceSyncStatus);
        mockDb.getPricesForToken.mockReturnValue(cachedPrices);

        const fetcherWithDb = new PriceFetcher(mockDb as unknown as TradeDB);
        const prices = await fetcherWithDb.getPricesForToken('token-123', 900, 1100);

        expect(mockDb.getPricesForToken).toHaveBeenCalledWith('token-123', 900, 1100);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(prices).toEqual(cachedPrices);
      });

      it('fetches from API when DB has no coverage', async () => {
        mockDb.getPriceSyncStatus.mockReturnValue({
          syncedFrom: undefined,
          syncedTo: undefined,
        } as PriceSyncStatus);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            history: [{ t: 1000, p: 0.5 }],
          }),
        });

        const fetcherWithDb = new PriceFetcher(mockDb as unknown as TradeDB);
        const prices = await fetcherWithDb.getPricesForToken('token-123', 900, 1100);

        expect(mockFetch).toHaveBeenCalled();
        expect(prices).toHaveLength(1);
      });

      it('fetches from API when DB coverage is partial', async () => {
        // DB has data from 1000-1050, but we need 900-1100
        mockDb.getPriceSyncStatus.mockReturnValue({
          syncedFrom: 1000,
          syncedTo: 1050,
        } as PriceSyncStatus);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            history: [
              { t: 900, p: 0.45 },
              { t: 1000, p: 0.5 },
            ],
          }),
        });

        const fetcherWithDb = new PriceFetcher(mockDb as unknown as TradeDB);
        const prices = await fetcherWithDb.getPricesForToken('token-123', 900, 1100);

        expect(mockFetch).toHaveBeenCalled();
        expect(prices).toHaveLength(2);
      });

      it('saves fetched prices to DB', async () => {
        mockDb.getPriceSyncStatus.mockReturnValue({
          syncedFrom: undefined,
          syncedTo: undefined,
        } as PriceSyncStatus);

        const apiPrices = [
          { t: 1000, p: 0.5 },
          { t: 1060, p: 0.52 },
        ];

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ history: apiPrices }),
        });

        const fetcherWithDb = new PriceFetcher(mockDb as unknown as TradeDB);
        await fetcherWithDb.getPricesForToken('token-123', 900, 1100);

        expect(mockDb.savePrices).toHaveBeenCalledWith('token-123', [
          { timestamp: 1000, price: 0.5 },
          { timestamp: 1060, price: 0.52 },
        ]);
      });

      it('does not save to DB when API returns empty', async () => {
        mockDb.getPriceSyncStatus.mockReturnValue({
          syncedFrom: undefined,
          syncedTo: undefined,
        } as PriceSyncStatus);

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ history: [] }),
        });

        const fetcherWithDb = new PriceFetcher(mockDb as unknown as TradeDB);
        await fetcherWithDb.getPricesForToken('token-123', 900, 1100);

        expect(mockDb.savePrices).not.toHaveBeenCalled();
      });
    });
  });

  describe('getPricesForMarket', () => {
    it('fetches prices for multiple tokens in parallel', async () => {
      const tokenIds = ['token-yes', 'token-no'];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ history: [{ t: 1000, p: 0.6 }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ history: [{ t: 1000, p: 0.4 }] }),
        });

      const result = await fetcher.getPricesForMarket(tokenIds, 900, 1100);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.size).toBe(2);
      expect(result.get('token-yes')).toEqual([{ timestamp: 1000, price: 0.6 }]);
      expect(result.get('token-no')).toEqual([{ timestamp: 1000, price: 0.4 }]);
    });

    it('returns empty map for empty token list', async () => {
      const result = await fetcher.getPricesForMarket([], 900, 1100);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });

    it('handles partial failures gracefully', async () => {
      const tokenIds = ['token-yes', 'token-no'];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ history: [{ t: 1000, p: 0.6 }] }),
        })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await fetcher.getPricesForMarket(tokenIds, 900, 1100);

      expect(result.size).toBe(2);
      expect(result.get('token-yes')).toEqual([{ timestamp: 1000, price: 0.6 }]);
      expect(result.get('token-no')).toEqual([]); // Empty due to error
    });
  });
});
