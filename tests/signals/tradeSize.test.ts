import { describe, it, expect } from 'vitest';
import { TradeSizeSignal } from '../../src/signals/tradeSize.js';
import type { AggregatedTrade } from '../../src/api/types.js';
import type { SignalContext } from '../../src/signals/types.js';
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
