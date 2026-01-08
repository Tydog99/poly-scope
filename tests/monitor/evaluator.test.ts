import { describe, it, expect } from 'vitest';
import { MonitorEvaluator } from '../../src/monitor/evaluator.js';
import type { RTDSTradeEvent } from '../../src/monitor/types.js';

describe('MonitorEvaluator', () => {
  const mockTradeEvent: RTDSTradeEvent = {
    asset: '123',
    conditionId: 'cond123',
    eventSlug: 'test-event',
    outcome: 'Yes',
    outcomeIndex: 0,
    price: 0.25,
    proxyWallet: '0xabc123',
    side: 'BUY',
    size: 10000,
    slug: 'test-market',
    timestamp: Date.now() / 1000,
    transactionHash: '0xtx123',
  };

  describe('shouldEvaluate', () => {
    it('returns false for trades below minSize', () => {
      const evaluator = new MonitorEvaluator({ minSize: 5000, threshold: 70 });
      const smallTrade = { ...mockTradeEvent, size: 100, price: 0.5 };
      expect(evaluator.shouldEvaluate(smallTrade)).toBe(false);
    });

    it('returns true for trades at or above minSize', () => {
      const evaluator = new MonitorEvaluator({ minSize: 5000, threshold: 70 });
      const largeTrade = { ...mockTradeEvent, size: 10000, price: 0.5 };
      expect(evaluator.shouldEvaluate(largeTrade)).toBe(true);
    });
  });

  describe('session cache', () => {
    it('caches account data for repeated evaluations', () => {
      const evaluator = new MonitorEvaluator({ minSize: 5000, threshold: 70 });

      // Check cache miss
      expect(evaluator.isCached(mockTradeEvent.proxyWallet)).toBe(false);

      // Simulate caching
      evaluator.cacheAccount(mockTradeEvent.proxyWallet, {
        wallet: mockTradeEvent.proxyWallet,
        totalTrades: 5,
        firstTradeDate: new Date(),
        lastTradeDate: new Date(),
        totalVolumeUsd: 50000,
        dataSource: 'subgraph',
      });

      // Check cache hit
      expect(evaluator.isCached(mockTradeEvent.proxyWallet)).toBe(true);
    });
  });
});
