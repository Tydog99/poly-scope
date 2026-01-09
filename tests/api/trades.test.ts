import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradeFetcher } from '../../src/api/trades.js';
import type { SubgraphClient } from '../../src/api/subgraph.js';
import type { Market } from '../../src/api/types.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Suppress console.log in tests
vi.spyOn(console, 'log').mockImplementation(() => { });

// Timestamps in seconds (API format) - Jan 15, 2024
const TRADE_TIMESTAMP = 1705320000;

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

    const fetcher = new TradeFetcher();
    const trades = await fetcher.getTradesForMarket('market-1');

    expect(trades).toHaveLength(1);
    expect(trades[0].transactionHash).toBe('0xtx1');
    expect(trades[0].totalValueUsd).toBe(500);
  });

  it('filters trades by outcome', async () => {
    const yesTrade = { ...mockDataApiTrade, transactionHash: '0xyes', outcome: 'Yes' };
    const noTrade = { ...mockDataApiTrade, transactionHash: '0xno', outcome: 'No' };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([yesTrade, noTrade]),
    });

    const fetcher = new TradeFetcher();
    const trades = await fetcher.getTradesForMarket('market-1', {
      outcome: 'YES',
    });

    expect(trades).toHaveLength(1);
    expect(trades[0].transactionHash).toBe('0xyes');
  });

  it('converts raw trade to Trade interface', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([mockDataApiTrade]),
    });

    const fetcher = new TradeFetcher();
    const trades = await fetcher.getTradesForMarket('market-1');
    const trade = trades[0];

    expect(trade.side).toBe('BUY');
    expect(trade.avgPrice).toBe(0.5);
    expect(trade.totalSize).toBe(1000);
    expect(trade.wallet).toBe('0xtaker');
    expect(trade.outcome).toBe('YES');
    expect(trade.timestamp).toBeInstanceOf(Date);
    expect(trade.timestamp.getTime()).toBe(TRADE_TIMESTAMP * 1000);
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

      const fetcher = new TradeFetcher({
        subgraphClient: mockSubgraphClient,
      });

      const trades = await fetcher.getTradesForMarket('0xcondition1', {
        market: mockMarket,
      });

      expect(mockSubgraphClient.getTradesByMarket).toHaveBeenCalledTimes(2); // YES and NO tokens
      expect(trades).toHaveLength(1);
      expect(trades[0].transactionHash).toBe('0xsubgraph_tx');
      expect(trades[0].wallet).toBe('0xtaker');
      expect(trades[0].outcome).toBe('YES');
      // Taker's action is OPPOSITE of maker's side.
      // Maker side = 'Buy' means taker is SELLING to fill the maker's buy order.
      expect(trades[0].side).toBe('SELL');
      expect(trades[0].totalSize).toBe(1000); // 500 USD / 0.5 price = 1000 shares
      expect(trades[0].avgPrice).toBe(0.5);
      expect(trades[0].totalValueUsd).toBe(500); // 500 USD
      // Check fills for role information
      expect(trades[0].fills[0].role).toBe('taker'); // Default role filter is 'taker'
      expect(trades[0].fills[0].maker).toBe('0xmaker');
      expect(trades[0].fills[0].taker).toBe('0xtaker');
    });

    it('falls back to Data API when subgraph fails', async () => {
      const mockSubgraphClient = {
        getTradesByMarket: vi.fn().mockRejectedValue(new Error('Subgraph timeout')),
      } as unknown as SubgraphClient;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([mockDataApiTrade]),
      });

      const fetcher = new TradeFetcher({
        subgraphClient: mockSubgraphClient,
      });

      const trades = await fetcher.getTradesForMarket('market-1', {
        market: mockMarket,
      });

      expect(trades).toHaveLength(1);
      expect(trades[0].transactionHash).toBe('0xtx1'); // From Data API
    });

    it('falls back to Data API when no token IDs provided', async () => {
      const mockSubgraphClient = {
        getTradesByMarket: vi.fn(),
      } as unknown as SubgraphClient;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([mockDataApiTrade]),
      });

      const fetcher = new TradeFetcher({
        subgraphClient: mockSubgraphClient,
      });

      // No market passed = no token IDs
      const trades = await fetcher.getTradesForMarket('market-1');

      expect(mockSubgraphClient.getTradesByMarket).not.toHaveBeenCalled();
      expect(trades).toHaveLength(1);
      expect(trades[0].transactionHash).toBe('0xtx1'); // From Data API
    });
  });

  describe('date filtering', () => {
    // Timestamps for test trades spanning Jan 1-5, 2026
    const JAN_1 = new Date('2026-01-01T12:00:00Z');
    const JAN_2 = new Date('2026-01-02T12:00:00Z');
    const JAN_3_MORNING = new Date('2026-01-03T08:00:00Z');
    const JAN_3_EVENING = new Date('2026-01-03T20:00:00Z');
    const JAN_4 = new Date('2026-01-04T12:00:00Z');
    const JAN_5 = new Date('2026-01-05T12:00:00Z');

    const makeDataApiTrade = (transactionHash: string, timestamp: Date) => ({
      proxyWallet: '0xwallet',
      side: 'BUY',
      size: 100,
      price: 0.5,
      timestamp: Math.floor(timestamp.getTime() / 1000),
      conditionId: 'market-1',
      outcome: 'Yes',
      transactionHash,
    });

    const dataApiTrades = [
      makeDataApiTrade('jan1', JAN_1),
      makeDataApiTrade('jan2', JAN_2),
      makeDataApiTrade('jan3-am', JAN_3_MORNING),
      makeDataApiTrade('jan3-pm', JAN_3_EVENING),
      makeDataApiTrade('jan4', JAN_4),
      makeDataApiTrade('jan5', JAN_5),
    ];

    it('filters trades after a given date', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(dataApiTrades),
      });

      const fetcher = new TradeFetcher();
      const trades = await fetcher.getTradesForMarket('market-1', {
        after: new Date('2026-01-03T00:00:00Z'), // Start of Jan 3
        maxTrades: 10,
      });

      // Should include Jan 3 morning, Jan 3 evening, Jan 4, Jan 5
      expect(trades.map(t => t.transactionHash)).toEqual(['jan3-am', 'jan3-pm', 'jan4', 'jan5']);
    });

    it('filters trades before a given date', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(dataApiTrades),
      });

      const fetcher = new TradeFetcher();
      const trades = await fetcher.getTradesForMarket('market-1', {
        before: new Date('2026-01-03T00:00:00Z'), // Midnight start of Jan 3
        maxTrades: 10,
      });

      // Should include Jan 1, Jan 2 only (Jan 3 trades are AFTER midnight)
      expect(trades.map(t => t.transactionHash)).toEqual(['jan1', 'jan2']);
    });

    it('filters trades within a date range', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(dataApiTrades),
      });

      const fetcher = new TradeFetcher();
      const trades = await fetcher.getTradesForMarket('market-1', {
        after: new Date('2026-01-02T00:00:00Z'),
        before: new Date('2026-01-03T23:59:59.999Z'),
        maxTrades: 10,
      });

      // Should include Jan 2, Jan 3 morning, Jan 3 evening
      expect(trades.map(t => t.transactionHash)).toEqual(['jan2', 'jan3-am', 'jan3-pm']);
    });

    it('returns empty array when no trades match date range', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(dataApiTrades),
      });

      const fetcher = new TradeFetcher();
      const trades = await fetcher.getTradesForMarket('market-1', {
        after: new Date('2026-01-10T00:00:00Z'), // Way after all trades
        maxTrades: 10,
      });

      expect(trades).toEqual([]);
    });
  });
});
