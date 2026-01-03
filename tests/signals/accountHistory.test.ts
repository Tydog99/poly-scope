import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AccountHistorySignal } from '../../src/signals/accountHistory.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { Trade, SignalContext, AccountHistory } from '../../src/signals/types.js';

const makeTrade = (): Trade => ({
  id: 'test-1',
  marketId: 'market-1',
  wallet: '0xabc',
  side: 'BUY',
  outcome: 'YES',
  size: 10000,
  price: 0.5,
  timestamp: new Date('2024-01-15T12:00:00Z'),
  valueUsd: 5000,
});

const makeContext = (history?: AccountHistory): SignalContext => ({
  config: DEFAULT_CONFIG,
  accountHistory: history,
});

describe('AccountHistorySignal', () => {
  const signal = new AccountHistorySignal();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns high score for new accounts with few trades', async () => {
    const history: AccountHistory = {
      wallet: '0xabc',
      totalTrades: 3,
      firstTradeDate: new Date('2024-01-13'), // 2 days old
      lastTradeDate: new Date('2024-01-15'),
      totalVolumeUsd: 10000,
    };

    const result = await signal.calculate(makeTrade(), makeContext(history));
    expect(result.score).toBeGreaterThan(60);
  });

  it('returns low score for established accounts', async () => {
    const history: AccountHistory = {
      wallet: '0xabc',
      totalTrades: 500,
      firstTradeDate: new Date('2023-01-01'), // over a year old
      lastTradeDate: new Date('2024-01-14'),
      totalVolumeUsd: 500000,
    };

    const result = await signal.calculate(makeTrade(), makeContext(history));
    expect(result.score).toBeLessThan(20);
  });

  it('returns high score for dormant accounts', async () => {
    const history: AccountHistory = {
      wallet: '0xabc',
      totalTrades: 50,
      firstTradeDate: new Date('2023-06-01'),
      lastTradeDate: new Date('2023-10-01'), // 106 days dormant
      totalVolumeUsd: 100000,
    };

    const result = await signal.calculate(makeTrade(), makeContext(history));
    expect(result.score).toBeGreaterThan(40);
  });

  it('returns max score when no history available', async () => {
    const result = await signal.calculate(makeTrade(), makeContext());
    expect(result.score).toBe(100);
  });

  it('has correct name and weight', () => {
    expect(signal.name).toBe('accountHistory');
    expect(signal.weight).toBe(35);
  });
});
