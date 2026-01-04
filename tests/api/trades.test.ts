import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { TradeFetcher } from '../../src/api/trades.js';
import type { RawTrade } from '../../src/api/types.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockRawTrade: RawTrade = {
  id: 'trade-1',
  taker_order_id: 'order-1',
  market: 'market-1',
  asset_id: 'asset-1',
  side: 'BUY',
  size: '1000',
  price: '0.50',
  timestamp: '1705320000',
  maker_address: '0xmaker',
  taker_address: '0xtaker',
};

describe('TradeFetcher', () => {
  let fetcher: TradeFetcher;

  beforeAll(() => {
    // Set up mock credentials for tests
    process.env.POLY_API_KEY = 'test-key';
    process.env.POLY_API_SECRET = 'dGVzdC1zZWNyZXQ='; // base64 "test-secret"
    process.env.POLY_PASSPHRASE = 'test-passphrase';
    process.env.POLY_WALLET = '0xtest';
  });

  beforeEach(() => {
    fetcher = new TradeFetcher();
    mockFetch.mockReset();
  });

  it('fetches trades for a market', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [mockRawTrade] }),
    });

    const trades = await fetcher.getTradesForMarket('market-1');

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('trade-1');
    expect(trades[0].valueUsd).toBe(500); // 1000 * 0.50
  });

  it('handles pagination', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [mockRawTrade],
          next_cursor: 'cursor-1'
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [{ ...mockRawTrade, id: 'trade-2' }]
        }),
      });

    const trades = await fetcher.getTradesForMarket('market-1');

    expect(trades).toHaveLength(2);
  });

  it('converts raw trade to Trade interface', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [mockRawTrade] }),
    });

    const trades = await fetcher.getTradesForMarket('market-1');
    const trade = trades[0];

    expect(trade.side).toBe('BUY');
    expect(trade.price).toBe(0.5);
    expect(trade.size).toBe(1000);
    expect(trade.wallet).toBe('0xtaker');
    expect(trade.timestamp).toBeInstanceOf(Date);
  });
});
