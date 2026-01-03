import { describe, it, expect } from 'vitest';
import { ConvictionSignal } from '../../src/signals/conviction.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { Trade, SignalContext, AccountHistory } from '../../src/signals/types.js';

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

const makeContext = (history?: Partial<AccountHistory>): SignalContext => ({
  config: DEFAULT_CONFIG,
  accountHistory: history ? {
    wallet: '0xabc',
    totalTrades: 10,
    firstTradeDate: new Date('2024-01-01'),
    lastTradeDate: new Date('2024-01-14'),
    totalVolumeUsd: 10000,
    ...history,
  } : undefined,
});

describe('ConvictionSignal', () => {
  const signal = new ConvictionSignal();

  it('returns high score when trade is large portion of total volume', async () => {
    const trade = makeTrade({ valueUsd: 9000 });
    const context = makeContext({ totalVolumeUsd: 10000 }); // 90% of portfolio

    const result = await signal.calculate(trade, context);
    expect(result.score).toBeGreaterThan(80);
  });

  it('returns low score for small portion trades', async () => {
    const trade = makeTrade({ valueUsd: 1000 });
    const context = makeContext({ totalVolumeUsd: 100000 }); // 1% of portfolio

    const result = await signal.calculate(trade, context);
    expect(result.score).toBeLessThan(20);
  });

  it('returns max score when no history available', async () => {
    const result = await signal.calculate(makeTrade(), makeContext());
    expect(result.score).toBe(100);
  });

  it('has correct name and weight', () => {
    expect(signal.name).toBe('conviction');
    expect(signal.weight).toBe(25);
  });
});
