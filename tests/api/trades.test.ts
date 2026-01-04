import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradeFetcher } from '../../src/api/trades.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockDataApiTrade = {
  proxyWallet: '0xtaker',
  side: 'BUY',
  size: '1000',
  price: '0.50',
  timestamp: 1705320000000,
  conditionId: 'market-1',
  outcome: 'Yes',
  transactionHash: '0xtx1',
};

describe('TradeFetcher', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fetches trades for a market', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([mockDataApiTrade]),
    });

    const fetcher = new TradeFetcher();
    const trades = await fetcher.getTradesForMarket('market-1');

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('0xtx1');
    expect(trades[0].valueUsd).toBe(500);
  });

  it('filters trades by date', async () => {
    const oldTrade = { ...mockDataApiTrade, transactionHash: '0xold', timestamp: 1704067200000 };
    const newTrade = { ...mockDataApiTrade, transactionHash: '0xnew', timestamp: 1705276800000 };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([oldTrade, newTrade]),
    });

    const fetcher = new TradeFetcher();
    const trades = await fetcher.getTradesForMarket('market-1', {
      after: new Date('2024-01-10'),
    });

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('0xnew');
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
    expect(trade.price).toBe(0.5);
    expect(trade.size).toBe(1000);
    expect(trade.wallet).toBe('0xtaker');
    expect(trade.outcome).toBe('YES');
    expect(trade.timestamp).toBeInstanceOf(Date);
  });
});
