import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AccountHistorySignal } from '../../src/signals/accountHistory.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { SignalContext, AccountHistory } from '../../src/signals/types.js';
import type { AggregatedTrade } from '../../src/api/types.js';

const makeTrade = (): AggregatedTrade => ({
  transactionHash: '0xtx1',
  marketId: 'market1',
  wallet: '0xwallet',
  side: 'BUY',
  outcome: 'YES',
  totalSize: 10000,
  totalValueUsd: 5000,
  avgPrice: 0.5,
  timestamp: new Date('2024-01-15T12:00:00Z'),
  fills: [{
    id: '0xtx1-0',
    size: 10000,
    price: 0.5,
    valueUsd: 5000,
    timestamp: Date.now() / 1000,
  }],
  fillCount: 1,
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
      totalTrades: 20, // Not established, but not brand new either
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

  describe('trade count scoring', () => {
    // Helper to create history with specific trade count
    const makeHistoryWithTrades = (totalTrades: number): AccountHistory => ({
      wallet: '0xabc',
      totalTrades,
      firstTradeDate: new Date('2024-01-10'), // 5 days old (moderately new)
      lastTradeDate: new Date('2024-01-15'),
      totalVolumeUsd: 10000,
    });

    it('returns max score for first trade (1 trade)', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(1)));
      // Trade count should contribute max score (~33 for 3-component)
      expect(result.details.tradeCountScore).toBe(33);
    });

    it('returns max score for zero trades', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(0)));
      expect(result.details.tradeCountScore).toBe(33);
    });

    it('returns 90% score for 2 trades', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(2)));
      // 90% of 33 ≈ 30
      expect(result.details.tradeCountScore).toBeCloseTo(30, 0);
    });

    it('returns 85% score for 3 trades', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(3)));
      // 85% of 33 ≈ 28
      expect(result.details.tradeCountScore).toBeCloseTo(28, 0);
    });

    it('returns 80% score for 4 trades', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(4)));
      // 80% of 33 ≈ 26
      expect(result.details.tradeCountScore).toBeCloseTo(26, 0);
    });

    it('returns 75% score for 5 trades', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(5)));
      // 75% of 33 ≈ 25
      expect(result.details.tradeCountScore).toBeCloseTo(25, 0);
    });

    it('returns ~70% score for 6 trades (start of decay)', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(6)));
      // 70% of 33 ≈ 23
      expect(result.details.tradeCountScore).toBeCloseTo(23, 0);
    });

    it('returns ~35% score for 28 trades (midpoint of decay)', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(28)));
      // Halfway between 6 and 50 should be ~35% of 33 ≈ 12
      expect(result.details.tradeCountScore).toBeCloseTo(12, 1);
    });

    it('returns near-zero score for 49 trades', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(49)));
      // Almost at 50, should be very low
      expect(result.details.tradeCountScore).toBeLessThan(3);
    });

    it('returns zero score for exactly 50 trades (established)', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(50)));
      expect(result.details.tradeCountScore).toBe(0);
    });

    it('returns zero score for 100+ trades', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(100)));
      expect(result.details.tradeCountScore).toBe(0);
    });

    it('returns zero score for 500+ trades', async () => {
      const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(500)));
      expect(result.details.tradeCountScore).toBe(0);
    });

    it('score decreases monotonically from 1 to 50 trades', async () => {
      let previousScore = 100;
      for (const trades of [1, 2, 3, 4, 5, 6, 10, 20, 30, 40, 49, 50]) {
        const result = await signal.calculate(makeTrade(), makeContext(makeHistoryWithTrades(trades)));
        expect(result.details.tradeCountScore).toBeLessThanOrEqual(previousScore);
        previousScore = result.details.tradeCountScore as number;
      }
    });
  });

  describe('account age calculation relative to trade timestamp', () => {
    it('calculates account age based on trade timestamp, not current date', async () => {
      // Set system time to 6 months after the trade
      vi.setSystemTime(new Date('2024-07-15T12:00:00Z'));

      const history: AccountHistory = {
        wallet: '0xabc',
        totalTrades: 5,
        firstTradeDate: new Date('2024-01-10'), // Account created Jan 10
        lastTradeDate: new Date('2024-01-14'),
        totalVolumeUsd: 10000,
      };

      // Trade happened on Jan 15 (5 days after account creation)
      const trade = {
        ...makeTrade(),
        timestamp: new Date('2024-01-15T12:00:00Z'),
      };

      const result = await signal.calculate(trade, makeContext(history));

      // Account should be 5 days old at trade time, NOT 6+ months old
      expect(result.details.accountAgeDays).toBe(5);
    });

    it('correctly scores historical trades from new accounts', async () => {
      // Set system time to 1 year after the trade
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

      const history: AccountHistory = {
        wallet: '0xabc',
        totalTrades: 2,
        firstTradeDate: new Date('2024-01-14'), // Account created 1 day before trade
        lastTradeDate: new Date('2024-01-15'),
        totalVolumeUsd: 50000,
      };

      const trade = {
        ...makeTrade(),
        timestamp: new Date('2024-01-15T12:00:00Z'),
      };

      const result = await signal.calculate(trade, makeContext(history));

      // Account was only 1 day old at trade time - should be very suspicious
      expect(result.details.accountAgeDays).toBe(1);
      // Age score gets scaled down due to volume bonus for high-volume new accounts
      // but should still be substantial (75% of max = ~25)
      expect(result.details.ageScore).toBeGreaterThan(20);
      expect(result.score).toBeGreaterThan(60); // High overall score
    });

    it('does not penalize old accounts in historical analysis', async () => {
      // Set system time to 2 years after the trade
      vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));

      const history: AccountHistory = {
        wallet: '0xabc',
        totalTrades: 500,
        firstTradeDate: new Date('2023-01-01'), // Account was already 1 year old at trade time
        lastTradeDate: new Date('2024-01-14'),
        totalVolumeUsd: 500000,
      };

      const trade = {
        ...makeTrade(),
        timestamp: new Date('2024-01-15T12:00:00Z'),
      };

      const result = await signal.calculate(trade, makeContext(history));

      // Account was ~1 year old at trade time - established account
      expect(result.details.accountAgeDays).toBeGreaterThan(365);
      expect(result.details.ageScore).toBe(0); // No age penalty for old account
      expect(result.score).toBeLessThan(20); // Low overall score
    });

    it('handles edge case where trade timestamp equals account creation', async () => {
      vi.setSystemTime(new Date('2024-06-01T12:00:00Z'));

      const history: AccountHistory = {
        wallet: '0xabc',
        totalTrades: 1,
        firstTradeDate: new Date('2024-01-15T12:00:00Z'),
        lastTradeDate: new Date('2024-01-15T12:00:00Z'),
        totalVolumeUsd: 10000,
      };

      const trade = {
        ...makeTrade(),
        timestamp: new Date('2024-01-15T12:00:00Z'), // Same as account creation
      };

      const result = await signal.calculate(trade, makeContext(history));

      // Account is 0 days old at trade time - maximum suspicion for age
      expect(result.details.accountAgeDays).toBe(0);
      expect(result.details.ageScore).toBe(33); // Max age score
    });
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
  });

  describe('point-in-time scoring', () => {
    it('uses historical trade count when available', async () => {
      const trade = makeTrade();
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 500, // Current count is high
        totalVolumeUsd: 100000,
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-12-01'),
        creationDate: new Date('2023-01-01'),
      };

      const context: SignalContext = {
        config: DEFAULT_CONFIG,
        accountHistory: history,
        historicalState: {
          tradeCount: 1, // But at trade time, they only had 1 trade!
          volume: 1000,
          pnl: 0,
          approximate: false,
        },
      };

      const result = await signal.calculate(trade, context);

      // Should score based on 1 trade (historical), not 500 (current)
      expect(result.details.tradeCountScore).toBeGreaterThan(20);
    });

    it('falls back to current trade count when historicalState is not available', async () => {
      const trade = makeTrade();
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 500, // Established trader
        totalVolumeUsd: 100000,
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-12-01'),
        creationDate: new Date('2023-01-01'),
      };

      const context: SignalContext = {
        config: DEFAULT_CONFIG,
        accountHistory: history,
        // No historicalState
      };

      const result = await signal.calculate(trade, context);

      // Should score based on 500 trades (current) - zero score for established trader
      expect(result.details.tradeCountScore).toBe(0);
    });

    it('reports historical trade count in details when available', async () => {
      const trade = makeTrade();
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 500,
        totalVolumeUsd: 100000,
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-12-01'),
        creationDate: new Date('2023-01-01'),
      };

      const context: SignalContext = {
        config: DEFAULT_CONFIG,
        accountHistory: history,
        historicalState: {
          tradeCount: 5,
          volume: 5000,
          pnl: 100,
          approximate: false,
        },
      };

      const result = await signal.calculate(trade, context);

      // Should report the historical state was used for scoring
      expect(result.details.totalTrades).toBe(5);
      expect(result.details.usingHistoricalState).toBe(true);
    });
  });

  describe('with subgraph data - Venezuela case', () => {
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

  describe('point-in-time dormancy', () => {
    it('uses lastTradeTimestamp from historical state', async () => {
      const tradeDate = new Date('2024-01-15');
      const trade: AggregatedTrade = {
        transactionHash: '0xtx1',
        marketId: 'market1',
        wallet: '0xwallet',
        side: 'BUY',
        outcome: 'YES',
        totalSize: 1000,
        totalValueUsd: 500,
        avgPrice: 0.5,
        timestamp: tradeDate,
        fills: [{
          id: '0xtx1-0',
          size: 1000,
          price: 0.5,
          valueUsd: 500,
          timestamp: tradeDate.getTime() / 1000,
        }],
        fillCount: 1,
      };

      // Last global trade is Jan 20 (AFTER this trade)
      // But point-in-time last trade was Jan 1 (BEFORE this trade)
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 100,
        totalVolumeUsd: 50000,
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-01-20'),  // Global: would give negative dormancy!
        creationDate: new Date('2023-01-01'),
      };

      const context: SignalContext = {
        config: DEFAULT_CONFIG,
        accountHistory: history,
        historicalState: {
          tradeCount: 50,
          volume: 25000000000,
          pnl: 0,
          lastTradeTimestamp: new Date('2024-01-01').getTime() / 1000, // 14 days before trade
          approximate: false,
        },
      };

      const result = await signal.calculate(trade, context);

      // Should use point-in-time: 14 days dormancy (Jan 1 to Jan 15)
      // NOT global: -5 days (Jan 20 to Jan 15, which is negative!)
      expect(result.details.dormancyDays).toBe(14);
    });

    it('returns 0 dormancy for first trade (no lastTradeTimestamp)', async () => {
      const trade = makeTrade();
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 100,
        totalVolumeUsd: 50000,
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-12-01'),
        creationDate: new Date('2023-01-01'),
      };

      const context: SignalContext = {
        config: DEFAULT_CONFIG,
        accountHistory: history,
        historicalState: {
          tradeCount: 0,    // First trade
          volume: 0,
          pnl: 0,
          // No lastTradeTimestamp - first trade has no prior trades
          approximate: false,
        },
      };

      const result = await signal.calculate(trade, context);

      // First trade = 0 dormancy (no prior trade to be dormant from)
      expect(result.details.dormancyDays).toBe(0);
      expect(result.details.dormancyScore).toBe(0);
    });

    it('never returns negative dormancy', async () => {
      const tradeDate = new Date('2024-01-15');
      const trade: AggregatedTrade = {
        transactionHash: '0xtx1',
        marketId: 'market1',
        wallet: '0xwallet',
        side: 'BUY',
        outcome: 'YES',
        totalSize: 1000,
        totalValueUsd: 500,
        avgPrice: 0.5,
        timestamp: tradeDate,
        fills: [{
          id: '0xtx1-0',
          size: 1000,
          price: 0.5,
          valueUsd: 500,
          timestamp: tradeDate.getTime() / 1000,
        }],
        fillCount: 1,
      };

      // Without historicalState, global lastTradeDate would give negative dormancy
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 100,
        totalVolumeUsd: 50000,
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-01-20'),  // AFTER trade - would be negative!
        creationDate: new Date('2023-01-01'),
      };

      // With proper historicalState, use the last trade BEFORE this one
      const context: SignalContext = {
        config: DEFAULT_CONFIG,
        accountHistory: history,
        historicalState: {
          tradeCount: 50,
          volume: 25000000000,
          pnl: 0,
          lastTradeTimestamp: new Date('2024-01-10').getTime() / 1000, // 5 days before
          approximate: false,
        },
      };

      const result = await signal.calculate(trade, context);

      // Should be 5 days (Jan 10 to Jan 15), not -5 days
      expect(result.details.dormancyDays).toBeGreaterThanOrEqual(0);
      expect(result.details.dormancyDays).toBe(5);
    });
  });

  describe('point-in-time profit', () => {
    it('uses point-in-time PnL instead of global profit', async () => {
      const trade = makeTrade();
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 100,
        totalVolumeUsd: 50000,
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-12-01'),
        creationDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days old
        profitUsd: 10000,  // Global: high profit (would score high)
      };

      const context: SignalContext = {
        config: DEFAULT_CONFIG,
        accountHistory: history,
        historicalState: {
          tradeCount: 5,
          volume: 5000000000,  // $5000 scaled
          pnl: 0,             // Point-in-time: no profit yet
          approximate: false,
        },
      };

      const result = await signal.calculate(trade, context);

      // Should use point-in-time profit ($0), not global ($10,000)
      expect(result.details.profitUsd).toBe(0);
      expect(result.details.profitScore).toBe(0);
    });

    it('first trade has zero profit', async () => {
      const trade = makeTrade();
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 100,
        totalVolumeUsd: 50000,
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-12-01'),
        creationDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        profitUsd: 5000,  // Global profit exists
      };

      const context: SignalContext = {
        config: DEFAULT_CONFIG,
        accountHistory: history,
        historicalState: {
          tradeCount: 0,    // First trade
          volume: 0,
          pnl: 0,           // No profit on first trade
          approximate: false,
        },
      };

      const result = await signal.calculate(trade, context);

      // First trade can't have generated profit yet
      expect(result.details.profitUsd).toBe(0);
      expect(result.details.profitScore).toBe(0);
    });
  });
});
