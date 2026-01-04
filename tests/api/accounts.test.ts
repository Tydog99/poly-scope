import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountFetcher } from '../../src/api/accounts.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AccountFetcher', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fetches account history', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { proxyWallet: '0xwallet', timestamp: 1704067200000, size: '100', price: '0.5' },
        { proxyWallet: '0xwallet', timestamp: 1705276800000, size: '200', price: '0.3' },
      ]),
    });

    const fetcher = new AccountFetcher();
    const history = await fetcher.getAccountHistory('0xwallet');

    expect(history.wallet).toBe('0xwallet');
    expect(history.totalTrades).toBe(2);
    expect(history.totalVolumeUsd).toBe(110);
  });

  it('handles accounts with no trades', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const fetcher = new AccountFetcher();
    const history = await fetcher.getAccountHistory('0xnewbie');

    expect(history.totalTrades).toBe(0);
    expect(history.firstTradeDate).toBeNull();
    expect(history.lastTradeDate).toBeNull();
  });

  it('calculates first and last trade dates', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { proxyWallet: '0xwallet', timestamp: 1704067200000, size: '100', price: '0.5' },
        { proxyWallet: '0xwallet', timestamp: 1705276800000, size: '200', price: '0.3' },
      ]),
    });

    const fetcher = new AccountFetcher();
    const history = await fetcher.getAccountHistory('0xwallet');

    expect(history.firstTradeDate?.getTime()).toBe(1704067200000);
    expect(history.lastTradeDate?.getTime()).toBe(1705276800000);
  });
});
