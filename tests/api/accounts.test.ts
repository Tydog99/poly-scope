import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { AccountFetcher } from '../../src/api/accounts.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AccountFetcher', () => {
  let fetcher: AccountFetcher;

  beforeAll(() => {
    // Set up mock credentials for tests
    process.env.POLY_API_KEY = 'test-key';
    process.env.POLY_API_SECRET = 'dGVzdC1zZWNyZXQ='; // base64 "test-secret"
    process.env.POLY_PASSPHRASE = 'test-passphrase';
    process.env.POLY_WALLET = '0xtest';
  });

  beforeEach(() => {
    fetcher = new AccountFetcher();
    mockFetch.mockReset();
  });

  it('fetches account history', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { timestamp: '1704067200', size: '100', price: '0.5' }, // Jan 1
          { timestamp: '1705276800', size: '200', price: '0.3' }, // Jan 15
        ],
      }),
    });

    const history = await fetcher.getAccountHistory('0xwallet');

    expect(history.wallet).toBe('0xwallet');
    expect(history.totalTrades).toBe(2);
    expect(history.totalVolumeUsd).toBe(110); // 100*0.5 + 200*0.3
  });

  it('handles accounts with no trades', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    const history = await fetcher.getAccountHistory('0xnewbie');

    expect(history.totalTrades).toBe(0);
    expect(history.firstTradeDate).toBeNull();
    expect(history.lastTradeDate).toBeNull();
  });

  it('calculates first and last trade dates', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { timestamp: '1704067200', size: '100', price: '0.5' },
          { timestamp: '1705276800', size: '200', price: '0.3' },
        ],
      }),
    });

    const history = await fetcher.getAccountHistory('0xwallet');

    expect(history.firstTradeDate?.getTime()).toBe(1704067200000);
    expect(history.lastTradeDate?.getTime()).toBe(1705276800000);
  });
});
