import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { RawTrade } from '../../src/api/types.js';

const mockGetTrades = vi.fn();

// Mock the ClobClient before any imports
vi.mock('@polymarket/clob-client', () => ({
  ClobClient: class {
    getTrades = mockGetTrades;
  },
}));

// Mock ethers Wallet
vi.mock('ethers', () => ({
  Wallet: class {
    constructor() {}
  },
}));

import { TradeFetcher } from '../../src/api/trades.js';

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
  beforeAll(() => {
    process.env.POLY_PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.POLY_API_KEY = 'test-key';
    process.env.POLY_API_SECRET = 'dGVzdC1zZWNyZXQ=';
    process.env.POLY_PASSPHRASE = 'test-passphrase';
  });

  it('fetches trades for a market', async () => {
    mockGetTrades.mockResolvedValue([mockRawTrade]);
    const fetcher = new TradeFetcher();
    const trades = await fetcher.getTradesForMarket('market-1');

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('trade-1');
    expect(trades[0].valueUsd).toBe(500);
  });

  it('filters trades by date', async () => {
    const oldTrade = { ...mockRawTrade, id: 'old', timestamp: '1704067200' };
    const newTrade = { ...mockRawTrade, id: 'new', timestamp: '1705276800' };
    mockGetTrades.mockResolvedValue([oldTrade, newTrade]);

    const fetcher = new TradeFetcher();
    const trades = await fetcher.getTradesForMarket('market-1', {
      after: new Date('2024-01-10'),
    });

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('new');
  });

  it('converts raw trade to Trade interface', async () => {
    mockGetTrades.mockResolvedValue([mockRawTrade]);
    const fetcher = new TradeFetcher();
    const trades = await fetcher.getTradesForMarket('market-1');
    const trade = trades[0];

    expect(trade.side).toBe('BUY');
    expect(trade.price).toBe(0.5);
    expect(trade.size).toBe(1000);
    expect(trade.wallet).toBe('0xtaker');
    expect(trade.timestamp).toBeInstanceOf(Date);
  });
});
