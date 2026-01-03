import { describe, it, expect } from 'vitest';
import { SignalAggregator } from '../../src/signals/aggregator.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { SignalResult } from '../../src/signals/types.js';

describe('SignalAggregator', () => {
  const aggregator = new SignalAggregator(DEFAULT_CONFIG);

  it('calculates weighted average of signals', () => {
    const signals: SignalResult[] = [
      { name: 'tradeSize', score: 100, weight: 40, details: {} },
      { name: 'accountHistory', score: 100, weight: 35, details: {} },
      { name: 'conviction', score: 100, weight: 25, details: {} },
    ];

    const result = aggregator.aggregate(signals);
    expect(result.total).toBe(100);
  });

  it('correctly weights different scores', () => {
    const signals: SignalResult[] = [
      { name: 'tradeSize', score: 50, weight: 40, details: {} },
      { name: 'accountHistory', score: 50, weight: 35, details: {} },
      { name: 'conviction', score: 50, weight: 25, details: {} },
    ];

    const result = aggregator.aggregate(signals);
    expect(result.total).toBe(50);
  });

  it('marks as alert when above threshold', () => {
    const signals: SignalResult[] = [
      { name: 'tradeSize', score: 80, weight: 40, details: {} },
      { name: 'accountHistory', score: 80, weight: 35, details: {} },
      { name: 'conviction', score: 80, weight: 25, details: {} },
    ];

    const result = aggregator.aggregate(signals);
    expect(result.isAlert).toBe(true);
    expect(result.total).toBe(80);
  });

  it('does not mark as alert when below threshold', () => {
    const signals: SignalResult[] = [
      { name: 'tradeSize', score: 50, weight: 40, details: {} },
      { name: 'accountHistory', score: 50, weight: 35, details: {} },
      { name: 'conviction', score: 50, weight: 25, details: {} },
    ];

    const result = aggregator.aggregate(signals);
    expect(result.isAlert).toBe(false);
  });

  it('includes all signal results in output', () => {
    const signals: SignalResult[] = [
      { name: 'tradeSize', score: 60, weight: 40, details: { foo: 'bar' } },
    ];

    const result = aggregator.aggregate(signals);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].details).toEqual({ foo: 'bar' });
  });
});
