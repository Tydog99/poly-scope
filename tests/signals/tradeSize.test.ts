import { describe, it, expect } from 'vitest';
import { TradeSizeSignal } from '../../src/signals/tradeSize.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { Trade, SignalContext, PricePoint } from '../../src/signals/types.js';

const makeContext = (prices: PricePoint[] = []): SignalContext => ({
  config: DEFAULT_CONFIG,
  marketPrices: prices,
});

const makeTrade = (overrides: Partial<Trade> = {}): Trade => ({
  id: 'test-1',
  marketId: 'market-1',
  wallet: '0xabc',
  side: 'BUY',
  outcome: 'YES',
  size: 10000,
  price: 0.5,
  timestamp: new Date('2024-01-15T12:00:00Z'),
  valueUsd: 5000,
  ...overrides,
});

describe('TradeSizeSignal', () => {
  const signal = new TradeSizeSignal();

  it('returns 0 for trades below minimum USD threshold', async () => {
    const trade = makeTrade({ valueUsd: 1000 }); // below $5000 default
    const result = await signal.calculate(trade, makeContext());
    expect(result.score).toBe(0);
  });

  it('returns higher score for larger trades', async () => {
    const smallTrade = makeTrade({ valueUsd: 5000 });
    const largeTrade = makeTrade({ valueUsd: 50000 });

    const smallResult = await signal.calculate(smallTrade, makeContext());
    const largeResult = await signal.calculate(largeTrade, makeContext());

    expect(largeResult.score).toBeGreaterThan(smallResult.score);
  });

  it('includes market impact in score when price data available', async () => {
    const trade = makeTrade({
      valueUsd: 10000,
      timestamp: new Date('2024-01-15T12:00:00Z'),
    });

    const pricesWithImpact: PricePoint[] = [
      { timestamp: new Date('2024-01-15T11:58:00Z'), price: 0.20 },
      { timestamp: new Date('2024-01-15T12:02:00Z'), price: 0.30 },
    ];

    const resultWithImpact = await signal.calculate(trade, makeContext(pricesWithImpact));
    const resultNoImpact = await signal.calculate(trade, makeContext());

    expect(resultWithImpact.score).toBeGreaterThan(resultNoImpact.score);
  });

  it('has correct name and weight', () => {
    expect(signal.name).toBe('tradeSize');
    expect(signal.weight).toBe(40);
  });
});
