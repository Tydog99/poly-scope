import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradeFetcher } from '../../src/api/trades.js';
import type { TradeCache } from '../../src/api/cache.js';
import type { SubgraphClient } from '../../src/api/subgraph.js';
import type { Market } from '../../src/api/types.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Suppress console.log in tests
vi.spyOn(console, 'log').mockImplementation(() => { });

// Timestamps in seconds (API format) - Jan 15, 2024
const TRADE_TIMESTAMP = 1705320000;

// Create a mock cache
const createMockCache = (): TradeCache =>
  ({
    load: vi.fn().mockReturnValue(null),
    save: vi.fn(),
    merge: vi.fn().mockImplementation((_marketId, trades) => ({
      marketId: 'market-1',
      newestTimestamp: TRADE_TIMESTAMP,
      oldestTimestamp: TRADE_TIMESTAMP,
      trades,
    })),
  }) as unknown as TradeCache;

const mockDataApiTrade = {
  proxyWallet: '0xtaker',
  side: 'BUY',
  size: 1000,
  price: 0.5,
  timestamp: TRADE_TIMESTAMP,
  conditionId: 'market-1',
  outcome: 'Yes',
  transactionHash: '0xtx1',
};

describe('TradeFetcher', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Default: return empty array (end of results)
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  it('fetches trades for a market', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([mockDataApiTrade]),
    });

    const fetcher = new TradeFetcher({ cache: createMockCache() });
    const trades = await fetcher.getTradesForMarket('market-1');

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('0xtx1');
    expect(trades[0].valueUsd).toBe(500);
  });

  it('filters trades by outcome', async () => {
    const yesTrade = { ...mockDataApiTrade, transactionHash: '0xyes', outcome: 'Yes' };
    const noTrade = { ...mockDataApiTrade, transactionHash: '0xno', outcome: 'No' };

    const mockCache = createMockCache();
    // Mock merge to convert Data API trades to our Trade format
    (mockCache.merge as ReturnType<typeof vi.fn>).mockImplementation((_marketId, trades) => ({
      marketId: 'market-1',
      newestTimestamp: TRADE_TIMESTAMP,
      oldestTimestamp: TRADE_TIMESTAMP,
      trades,
    }));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([yesTrade, noTrade]),
    });

    const fetcher = new TradeFetcher({ cache: mockCache });
    const trades = await fetcher.getTradesForMarket('market-1', {
      outcome: 'YES',
    });

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('0xyes');
  });

  it('converts raw trade to Trade interface', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([mockDataApiTrade]),
    });

    const fetcher = new TradeFetcher({ cache: createMockCache() });
    const trades = await fetcher.getTradesForMarket('market-1');
    const trade = trades[0];

    expect(trade.side).toBe('BUY');
    expect(trade.price).toBe(0.5);
    expect(trade.size).toBe(1000);
    expect(trade.wallet).toBe('0xtaker');
    expect(trade.outcome).toBe('YES');
    expect(trade.timestamp).toBeInstanceOf(Date);
    expect(trade.timestamp.getTime()).toBe(TRADE_TIMESTAMP * 1000);
  });

  it('uses cached trades when available', async () => {
    const cachedTrade = {
      id: '0xcached',
      marketId: 'market-1',
      wallet: '0xwallet',
      side: 'BUY' as const,
      outcome: 'YES' as const,
      size: 100,
      price: 0.5,
      timestamp: new Date(TRADE_TIMESTAMP * 1000),
      valueUsd: 50,
    };

    const mockCache = createMockCache();
    (mockCache.load as ReturnType<typeof vi.fn>).mockReturnValue({
      marketId: 'market-1',
      newestTimestamp: TRADE_TIMESTAMP,
      oldestTimestamp: TRADE_TIMESTAMP,
      trades: [cachedTrade],
    });

    // No new trades
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const fetcher = new TradeFetcher({ cache: mockCache });
    // Set maxTrades to 1 so no backfill is attempted
    const trades = await fetcher.getTradesForMarket('market-1', { maxTrades: 1 });

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('0xcached');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  describe('with subgraph', () => {
    const mockMarket: Market = {
      conditionId: '0xcondition1',
      questionId: '0xquestion1',
      question: 'Will X happen?',
      outcomes: ['Yes', 'No'],
      tokens: [
        { tokenId: '0xyes_token', outcome: 'Yes' },
        { tokenId: '0xno_token', outcome: 'No' },
      ],
      resolutionSource: 'https://example.com',
      endDate: '2024-12-31',
      resolved: false,
    };

    const mockSubgraphTrade = {
      id: 'trade-1',
      transactionHash: '0xsubgraph_tx',
      timestamp: TRADE_TIMESTAMP,
      maker: '0xmaker',
      taker: '0xtaker',
      marketId: '0xyes_token',
      side: 'Buy' as const,
      size: '500000000', // 500 USD in 6 decimals
      price: '0.5', // price as decimal string (not 6 decimals)
    };

    it('uses subgraph as primary when available', async () => {
      const mockSubgraphClient = {
        getTradesByMarket: vi
          .fn()
          .mockResolvedValueOnce([mockSubgraphTrade]) // YES token
          .mockResolvedValueOnce([]), // NO token (no trades)
      } as unknown as SubgraphClient;

      const mockCache = createMockCache();

      const fetcher = new TradeFetcher({
        cache: mockCache,
        subgraphClient: mockSubgraphClient,
      });

      const trades = await fetcher.getTradesForMarket('0xcondition1', {
        market: mockMarket,
      });

      expect(mockSubgraphClient.getTradesByMarket).toHaveBeenCalledTimes(2); // YES and NO tokens
      expect(trades).toHaveLength(1);
      expect(trades[0].id).toBe('0xsubgraph_tx');
      expect(trades[0].wallet).toBe('0xtaker');
      expect(trades[0].outcome).toBe('YES');
      // Taker's action is OPPOSITE of maker's side.
      // Maker side = 'Buy' means taker is SELLING to fill the maker's buy order.
      expect(trades[0].side).toBe('SELL');
      expect(trades[0].size).toBe(1000); // 500 USD / 0.5 price = 1000 shares
      expect(trades[0].price).toBe(0.5);
      expect(trades[0].valueUsd).toBe(500); // 500 USD
      expect(trades[0].role).toBe('taker'); // Default role filter is 'taker'
      expect(trades[0].maker).toBe('0xmaker');
      expect(trades[0].taker).toBe('0xtaker');
    });

    it('falls back to Data API when subgraph fails', async () => {
      const mockSubgraphClient = {
        getTradesByMarket: vi.fn().mockRejectedValue(new Error('Subgraph timeout')),
      } as unknown as SubgraphClient;

      const mockCache = createMockCache();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([mockDataApiTrade]),
      });

      const fetcher = new TradeFetcher({
        cache: mockCache,
        subgraphClient: mockSubgraphClient,
      });

      const trades = await fetcher.getTradesForMarket('market-1', {
        market: mockMarket,
      });

      expect(trades).toHaveLength(1);
      expect(trades[0].id).toBe('0xtx1'); // From Data API
    });

    it('falls back to Data API when no token IDs provided', async () => {
      const mockSubgraphClient = {
        getTradesByMarket: vi.fn(),
      } as unknown as SubgraphClient;

      const mockCache = createMockCache();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([mockDataApiTrade]),
      });

      const fetcher = new TradeFetcher({
        cache: mockCache,
        subgraphClient: mockSubgraphClient,
      });

      // No market passed = no token IDs
      const trades = await fetcher.getTradesForMarket('market-1');

      expect(mockSubgraphClient.getTradesByMarket).not.toHaveBeenCalled();
      expect(trades).toHaveLength(1);
      expect(trades[0].id).toBe('0xtx1'); // From Data API
    });

    it('uses cached timestamp for incremental query', async () => {
      const mockSubgraphClient = {
        getTradesByMarket: vi.fn().mockResolvedValue([]),
      } as unknown as SubgraphClient;

      const mockCache = createMockCache();
      const cachedDate = new Date(TRADE_TIMESTAMP * 1000);

      // Setup cache with existing trades
      (mockCache.load as ReturnType<typeof vi.fn>).mockReturnValue({
        marketId: '0xcondition1',
        newestTimestamp: TRADE_TIMESTAMP,
        oldestTimestamp: TRADE_TIMESTAMP - 1000,
        trades: [{ id: 'old_trade', timestamp: cachedDate } as any],
      });

      const fetcher = new TradeFetcher({
        cache: mockCache,
        subgraphClient: mockSubgraphClient,
      });

      await fetcher.getTradesForMarket('0xcondition1', {
        market: mockMarket,
      });

      // Verify called with correct date filter
      expect(mockSubgraphClient.getTradesByMarket).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          after: cachedDate,
        })
      );
    });

    it('returns cached trades when no new trades found', async () => {
      const mockSubgraphClient = {
        getTradesByMarket: vi.fn().mockResolvedValue([]),
      } as unknown as SubgraphClient;

      const mockCache = createMockCache();
      const cachedTrades = [{
        id: 'old_trade',
        timestamp: new Date(TRADE_TIMESTAMP * 1000),
        wallet: '0xold',
        valueUsd: 100
      } as any];

      (mockCache.load as ReturnType<typeof vi.fn>).mockReturnValue({
        marketId: '0xcondition1',
        newestTimestamp: TRADE_TIMESTAMP,
        oldestTimestamp: TRADE_TIMESTAMP,
        trades: cachedTrades,
      });

      const fetcher = new TradeFetcher({
        cache: mockCache,
        subgraphClient: mockSubgraphClient,
      });

      const trades = await fetcher.getTradesForMarket('0xcondition1', {
        market: mockMarket,
      });

      expect(trades).toHaveLength(1);
      expect(trades[0].id).toBe('old_trade');
    });
  });
});
