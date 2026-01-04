import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradeFetcher } from '../../src/api/trades.js';
import type { TradeCache } from '../../src/api/cache.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Suppress console.log in tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// Timestamps in seconds (API format) - Jan 15, 2024
const TRADE_TIMESTAMP = 1705320000;

// Create a mock cache
const createMockCache = (): TradeCache => ({
  load: vi.fn().mockReturnValue(null),
  save: vi.fn(),
  merge: vi.fn().mockImplementation((_marketId, trades) => ({
    marketId: 'market-1',
    newestTimestamp: TRADE_TIMESTAMP,
    oldestTimestamp: TRADE_TIMESTAMP,
    trades,
  })),
} as unknown as TradeCache);

const mockDataApiTrade = {
  proxyWallet: '0xtaker',
  side: 'BUY',
  size: 1000,
  price: 0.50,
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

    const fetcher = new TradeFetcher(createMockCache());
    const trades = await fetcher.getTradesForMarket('market-1');

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('0xtx1');
    expect(trades[0].valueUsd).toBe(500);
  });

  it('filters trades by outcome', async () => {
    const yesTrade = { ...mockDataApiTrade, transactionHash: '0xyes', outcome: 'Yes' };
    const noTrade = { ...mockDataApiTrade, transactionHash: '0xno', outcome: 'No' };

    const mockCache = createMockCache();
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

    const fetcher = new TradeFetcher(mockCache);
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

    const fetcher = new TradeFetcher(createMockCache());
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

    const fetcher = new TradeFetcher(mockCache);
    // Set maxTrades to 1 so no backfill is attempted
    const trades = await fetcher.getTradesForMarket('market-1', { maxTrades: 1 });

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('0xcached');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
