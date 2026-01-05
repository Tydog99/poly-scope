import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyzeCommand } from '../../src/commands/analyze.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

// Mock all dependencies
vi.mock('../../src/api/client.js', () => ({
  PolymarketClient: class {
    getMarket = vi.fn().mockResolvedValue({
      conditionId: 'test-market',
      question: 'Test market?',
      outcomes: ['Yes', 'No'],
      resolved: true,
      winningOutcome: 'Yes',
      createdAt: new Date('2024-01-01').toISOString()
    });
  },
}));

// Mock signals to return high scores so we can test filtering
vi.mock('../../src/signals/index.js', () => ({
  TradeSizeSignal: class {
    calculate = vi.fn().mockResolvedValue({ name: 'tradeSize', score: 90, weight: 40, details: {} });
  },
  AccountHistorySignal: class {
    calculate = vi.fn().mockResolvedValue({ name: 'accountHistory', score: 90, weight: 35, details: {} });
  },
  ConvictionSignal: class {
    calculate = vi.fn().mockResolvedValue({ name: 'conviction', score: 90, weight: 25, details: {} });
  },
  SignalAggregator: class {
    aggregate = vi.fn().mockReturnValue({
      total: 90,
      signals: [],
      isAlert: true // FORCE ALL TRADES TO BE ALERTS
    });
  },
}));

const mockTrades = [
  {
    id: 't1',
    marketId: 'test-market',
    wallet: '0xsuspicious',
    side: 'BUY',
    outcome: 'YES',
    size: 50000,
    price: 0.2, // Low price, should KEPT
    timestamp: new Date('2024-01-15'),
    valueUsd: 10000,
  },
  {
    id: 't2',
    marketId: 'test-market',
    wallet: '0xwhale',
    side: 'BUY',
    outcome: 'YES',
    size: 100000,
    price: 0.98, // High price BUY, should be FILTERED
    timestamp: new Date('2024-01-15'),
    valueUsd: 98000,
  },
  {
    id: 't3',
    marketId: 'test-market',
    wallet: '0xseller',
    side: 'SELL',
    outcome: 'YES',
    size: 100000,
    price: 0.99, // High price SELL, should be FILTERED
    timestamp: new Date('2024-01-15'),
    valueUsd: 99000,
  },
];

vi.mock('../../src/api/trades.js', () => ({
  TradeFetcher: class {
    getTradesForMarket = vi.fn().mockResolvedValue(mockTrades);
  },
}));

vi.mock('../../src/api/accounts.js', () => ({
  AccountFetcher: class {
    getAccountHistory = vi.fn().mockResolvedValue({
      wallet: '0xsuspicious',
      totalTrades: 2,
      firstTradeDate: new Date('2024-01-14'),
      lastTradeDate: new Date('2024-01-15'),
      totalVolumeUsd: 10000,
    });
  },
}));

describe('AnalyzeCommand', () => {
  let command: AnalyzeCommand;

  beforeEach(() => {
    command = new AnalyzeCommand(DEFAULT_CONFIG);
  });

  it('analyzes a market and returns report', async () => {
    // Default config has excludeSafeBets: true and safeBetThreshold: 0.95
    const report = await command.execute({ marketId: 'test-market' });

    expect(report.market.conditionId).toBe('test-market');

    // Should filter out t2 (BUY 0.98) and t3 (SELL 0.99)
    // Should keep t1 (BUY 0.2)
    const tradeIds = report.suspiciousTrades.map(st => st.trade.id);
    expect(tradeIds).toContain('t1');
    expect(tradeIds).not.toContain('t2');
    expect(tradeIds).not.toContain('t3');
  });

  it('filters to winning side trades only', async () => {
    const report = await command.execute({ marketId: 'test-market' });

    // All suspicious trades should be on winning outcome
    report.suspiciousTrades.forEach(st => {
      expect(st.trade.outcome).toBe('YES');
    });
  });

  it('filters out high price safe bets (BUY and SELL)', async () => {
    const customConfig = {
      ...DEFAULT_CONFIG,
      filters: { excludeSafeBets: true, safeBetThreshold: 0.90 }
    };
    const cmd = new AnalyzeCommand(customConfig);
    const report = await cmd.execute({ marketId: 'test-market' });

    const tradeIds = report.suspiciousTrades.map(st => st.trade.id);
    expect(tradeIds).toContain('t1');      // Price 0.2 < 0.90 -> Keep
    expect(tradeIds).not.toContain('t2');  // Price 0.98 > 0.90 -> Filter
    expect(tradeIds).not.toContain('t3');  // Price 0.99 > 0.90 -> Filter
  });

  it('keeps high price bets if filter is disabled', async () => {
    const customConfig = {
      ...DEFAULT_CONFIG,
      filters: { excludeSafeBets: false, safeBetThreshold: 0.95 }
    };
    const cmd = new AnalyzeCommand(customConfig);
    const report = await cmd.execute({ marketId: 'test-market' });

    const tradeIds = report.suspiciousTrades.map(st => st.trade.id);
    expect(tradeIds).toContain('t1');
    expect(tradeIds).toContain('t2'); // Should be kept now
    expect(tradeIds).toContain('t3'); // Should be kept now
  });
});
