import { describe, it, expect } from 'vitest';
import { TradeSizeSignal } from '../../src/signals/tradeSize.js';
import type { AggregatedTrade } from '../../src/api/types.js';
import type { SignalContext, PricePoint } from '../../src/signals/types.js';
import { loadConfig } from '../../src/config.js';

describe('TradeSizeSignal', () => {
  const signal = new TradeSizeSignal();
  const config = loadConfig();

  const makeTrade = (valueUsd: number): AggregatedTrade => ({
    transactionHash: '0xtx1',
    marketId: 'market1',
    wallet: '0xwallet',
    side: 'BUY',
    outcome: 'YES',
    totalSize: valueUsd / 0.5, // Assume 50 cent price
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

  const baseContext: SignalContext = { config };

  it('returns 0 for trades below threshold', async () => {
    const trade = makeTrade(100); // Below $5000 default
    const result = await signal.calculate(trade, baseContext);
    expect(result.score).toBe(0);
    expect(result.details.reason).toBe('below_threshold');
  });

  it('scores trades at threshold as 25', async () => {
    const trade = makeTrade(5000); // Exactly at threshold
    const result = await signal.calculate(trade, baseContext);
    expect(result.score).toBe(25); // log10(1) * 25 + 25 = 25
  });

  it('scores large trades higher', async () => {
    const trade = makeTrade(50000); // 10x threshold
    const result = await signal.calculate(trade, baseContext);
    expect(result.score).toBe(50); // log10(10) * 25 + 25 = 50
  });

  it('caps score at 100', async () => {
    const trade = makeTrade(5000000); // 1000x threshold
    const result = await signal.calculate(trade, baseContext);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe('TradeSizeSignal with Map-based prices', () => {
  const signal = new TradeSizeSignal();

  const mockTrade: AggregatedTrade = {
    transactionHash: '0xabc',
    wallet: '0x123',
    marketId: 'token-456',
    outcome: 'YES',
    side: 'BUY',
    avgPrice: 0.5,
    totalSize: 1000,
    totalValueUsd: 5000,
    timestamp: new Date(1000000 * 1000),
    fillCount: 1,
    fills: [],
  };

  it('calculates impact from per-token price Map', async () => {
    const pricesMap = new Map<string, PricePoint[]>();
    pricesMap.set('token-456', [
      { timestamp: new Date(999700 * 1000), price: 0.4 },
      { timestamp: new Date(1000300 * 1000), price: 0.5 },
    ]);

    const context: SignalContext = {
      config: {
        tradeSize: { minAbsoluteUsd: 1000, minImpactPercent: 5, impactWindowMinutes: 5 },
        accountHistory: { maxAgeDays: 30, maxTradeCount: 50, dormancyDays: 90 },
        conviction: { highConvictionThreshold: 0.85 },
        alertThreshold: 70,
        filters: { excludeSafeBets: true, safeBetThreshold: 0.9 },
        subgraph: { enabled: true, timeout: 30000, retries: 3 },
      },
      marketPrices: pricesMap,
    };

    const result = await signal.calculate(mockTrade, context);
    // This test will initially fail because TradeSizeSignal expects array, not Map
    // It should pass after Task 5 updates TradeSizeSignal
    expect(result.details).toHaveProperty('impactPercent');
  });
});
