import { describe, it, expect } from 'vitest';
import { ConvictionSignal } from '../../src/signals/conviction.js';
import type { AggregatedTrade } from '../../src/api/types.js';
import type { SignalContext, AccountHistory } from '../../src/signals/types.js';
import { loadConfig } from '../../src/config.js';

describe('ConvictionSignal', () => {
  const signal = new ConvictionSignal();
  const config = loadConfig();

  const makeTrade = (valueUsd: number): AggregatedTrade => ({
    transactionHash: '0xtx1',
    marketId: 'market1',
    wallet: '0xwallet',
    side: 'BUY',
    outcome: 'YES',
    totalSize: valueUsd / 0.5,
    totalValueUsd: valueUsd,
    avgPrice: 0.5,
    timestamp: new Date(),
    fills: [{
      id: '0xtx1-0',
      size: valueUsd / 0.5,
      price: 0.5,
      valueUsd,
      timestamp: Date.now() / 1000,
    }],
    fillCount: 1,
  });

  const makeHistory = (totalVolumeUsd: number): AccountHistory => ({
    wallet: '0xwallet',
    totalTrades: 10,
    firstTradeDate: new Date('2024-01-01'),
    lastTradeDate: new Date(),
    totalVolumeUsd,
  });

  it('returns high score for new wallets with no history', async () => {
    const trade = makeTrade(10000);
    const context: SignalContext = { config };

    const result = await signal.calculate(trade, context);
    expect(result.score).toBe(80);
    expect(result.details.reason).toBe('no_history');
  });

  it('returns max score for 50%+ concentration', async () => {
    const trade = makeTrade(10000);
    const context: SignalContext = {
      config,
      accountHistory: makeHistory(15000), // 66% concentration
    };

    const result = await signal.calculate(trade, context);
    expect(result.score).toBe(100);
  });

  it('returns medium score for 10-25% concentration', async () => {
    const trade = makeTrade(10000);
    const context: SignalContext = {
      config,
      accountHistory: makeHistory(50000), // 20% concentration
    };

    const result = await signal.calculate(trade, context);
    expect(result.score).toBeGreaterThan(40);
    expect(result.score).toBeLessThan(70);
  });

  it('returns low score for <5% concentration', async () => {
    const trade = makeTrade(1000);
    const context: SignalContext = {
      config,
      accountHistory: makeHistory(100000), // 1% concentration
    };

    const result = await signal.calculate(trade, context);
    expect(result.score).toBeLessThan(20);
  });

  it('has correct name and weight', () => {
    expect(signal.name).toBe('conviction');
    expect(signal.weight).toBe(25);
  });

  describe('point-in-time scoring', () => {
    it('uses historical volume when available', async () => {
      const trade = makeTrade(5000);
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 500,
        totalVolumeUsd: 100000, // Current volume is high
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-12-01'),
      };

      const context: SignalContext = {
        config,
        accountHistory: history,
        historicalState: {
          tradeCount: 1,
          volume: 1000000, // But at trade time, they only had $1 volume (scaled by 1e6)
          pnl: 0,
          approximate: false,
        },
      };

      const result = await signal.calculate(trade, context);

      // 5000 / (1 + 1) = 2500% concentration using historical volume
      // vs 5000 / 100000 = 5% concentration using current volume
      // With historical volume of $1, the concentration should be extremely high (100%)
      expect(result.score).toBe(100);
      expect(result.details.concentrationPercent).toBeGreaterThan(100);
    });

    it('falls back to current volume when historical state not available', async () => {
      const trade = makeTrade(5000);
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 500,
        totalVolumeUsd: 100000, // 5% concentration
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-12-01'),
      };

      const context: SignalContext = {
        config,
        accountHistory: history,
        // No historicalState provided
      };

      const result = await signal.calculate(trade, context);

      // 5000 / 100000 = 5% concentration
      expect(result.details.concentrationPercent).toBe(5);
    });
  });
});
