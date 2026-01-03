import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountFetcher } from '../../src/api/accounts.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AccountFetcher', () => {
  let fetcher: AccountFetcher;

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
