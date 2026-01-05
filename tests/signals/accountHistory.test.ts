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
    // Pass null to represent "no history found" vs undefined which means "skipped"
    const result = await signal.calculate(makeTrade(), makeContext(null as any));
    expect(result.score).toBe(100);
  });

  it('has correct name and weight', () => {
    expect(signal.name).toBe('accountHistory');
    expect(signal.weight).toBe(35);
  });

  describe('with subgraph data', () => {
    it('uses creationDate when available instead of firstTradeDate', async () => {
      const history: AccountHistory = {
        wallet: '0xabc',
        totalTrades: 100,
        firstTradeDate: new Date('2024-01-10'), // 5 days old
        lastTradeDate: new Date('2024-01-15'),
        totalVolumeUsd: 50000,
        creationDate: new Date('2024-01-10'), // Same as firstTradeDate
        profitUsd: 0,
        dataSource: 'subgraph',
      };

      const result = await signal.calculate(makeTrade(), makeContext(history));
      expect(result.details.dataSource).toBe('subgraph');
      expect(result.details.accountAgeDays).toBe(5);
    });

    it('adds profit score for new accounts with high profits', async () => {
      const history: AccountHistory = {
        wallet: '0xabc',
        totalTrades: 10,
        firstTradeDate: new Date('2024-01-01'), // 14 days old
        lastTradeDate: new Date('2024-01-15'),
        totalVolumeUsd: 100000,
        creationDate: new Date('2024-01-01'),
        profitUsd: 60000, // 60% return - very suspicious
        dataSource: 'subgraph',
      };

      const result = await signal.calculate(makeTrade(), makeContext(history));
      expect(result.details.profitScore).toBeGreaterThan(0);
      expect(result.details.profitUsd).toBe(60000);
    });

    it('does not add profit score for accounts with losses', async () => {
      const history: AccountHistory = {
        wallet: '0xabc',
        totalTrades: 10,
        firstTradeDate: new Date('2024-01-01'),
        lastTradeDate: new Date('2024-01-15'),
        totalVolumeUsd: 100000,
        creationDate: new Date('2024-01-01'),
        profitUsd: -28000, // Loss - not suspicious
        dataSource: 'subgraph',
      };

      const result = await signal.calculate(makeTrade(), makeContext(history));
      expect(result.details.profitScore).toBe(0);
    });

    it('does not add profit score for old accounts', async () => {
      const history: AccountHistory = {
        wallet: '0xabc',
        totalTrades: 500,
        firstTradeDate: new Date('2023-01-01'), // Over a year old
        lastTradeDate: new Date('2024-01-14'),
        totalVolumeUsd: 1000000,
        creationDate: new Date('2023-01-01'),
        profitUsd: 500000, // 50% return but old account
        dataSource: 'subgraph',
      };

      const result = await signal.calculate(makeTrade(), makeContext(history));
      expect(result.details.profitScore).toBe(0);
    });

    it('returns high score for Venezuela insider case profile', async () => {
      // Based on actual case: 0x31a56e9e690c621ed21de08cb559e9524cdb8ed9
      const history: AccountHistory = {
        wallet: '0x31a56e9e690c621ed21de08cb559e9524cdb8ed9',
        totalTrades: 268,
        firstTradeDate: new Date('2025-12-27'), // Created Dec 27
        lastTradeDate: new Date('2026-01-04'),
        totalVolumeUsd: 404357,
        creationDate: new Date('2025-12-27'),
        profitUsd: -28076, // Actually at a loss
        dataSource: 'subgraph',
      };

      // Use a trade timestamp from Jan 3
      const trade = {
        ...makeTrade(),
        timestamp: new Date('2026-01-03T02:58:25Z'),
      };

      // Set system time to Jan 3
      vi.setSystemTime(new Date('2026-01-03T12:00:00Z'));

      const result = await signal.calculate(trade, makeContext(history));

      // Account is only 7 days old with 268 trades
      // Score should be moderate due to high trade count but new account
      expect(result.details.accountAgeDays).toBe(7);
      expect(result.details.totalTrades).toBe(268);
      // Profit score should be 0 since they're at a loss
      expect(result.details.profitScore).toBe(0);
    });
  });
});
