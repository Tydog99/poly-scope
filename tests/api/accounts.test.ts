import { describe, it, expect, vi, beforeAll } from 'vitest';

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

import { AccountFetcher } from '../../src/api/accounts.js';

describe('AccountFetcher', () => {
  beforeAll(() => {
    process.env.POLY_PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.POLY_API_KEY = 'test-key';
    process.env.POLY_API_SECRET = 'dGVzdC1zZWNyZXQ=';
    process.env.POLY_PASSPHRASE = 'test-passphrase';
  });

  it('fetches account history', async () => {
    mockGetTrades.mockResolvedValue([
      { timestamp: '1704067200', size: '100', price: '0.5' },
      { timestamp: '1705276800', size: '200', price: '0.3' },
    ]);

    const fetcher = new AccountFetcher();
    const history = await fetcher.getAccountHistory('0xwallet');

    expect(history.wallet).toBe('0xwallet');
    expect(history.totalTrades).toBe(2);
    expect(history.totalVolumeUsd).toBe(110);
  });

  it('handles accounts with no trades', async () => {
    mockGetTrades.mockResolvedValue([]);

    const fetcher = new AccountFetcher();
    const history = await fetcher.getAccountHistory('0xnewbie');

    expect(history.totalTrades).toBe(0);
    expect(history.firstTradeDate).toBeNull();
    expect(history.lastTradeDate).toBeNull();
  });

  it('calculates first and last trade dates', async () => {
    mockGetTrades.mockResolvedValue([
      { timestamp: '1704067200', size: '100', price: '0.5' },
      { timestamp: '1705276800', size: '200', price: '0.3' },
    ]);

    const fetcher = new AccountFetcher();
    const history = await fetcher.getAccountHistory('0xwallet');

    expect(history.firstTradeDate?.getTime()).toBe(1704067200000);
    expect(history.lastTradeDate?.getTime()).toBe(1705276800000);
  });
});
