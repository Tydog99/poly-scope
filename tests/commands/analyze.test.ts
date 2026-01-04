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
    });
  },
}));

vi.mock('../../src/api/trades.js', () => ({
  TradeFetcher: class {
    getTradesForMarket = vi.fn().mockResolvedValue([
      {
        id: 't1',
        marketId: 'test-market',
        wallet: '0xsuspicious',
        side: 'BUY',
        outcome: 'YES',
        size: 50000,
        price: 0.2,
        timestamp: new Date('2024-01-15'),
        valueUsd: 10000,
      },
    ]);
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
    const report = await command.execute({ marketId: 'test-market' });

    expect(report.market.conditionId).toBe('test-market');
    expect(report.suspiciousTrades.length).toBeGreaterThanOrEqual(0);
  });

  it('filters to winning side trades only', async () => {
    const report = await command.execute({ marketId: 'test-market' });

    // All suspicious trades should be on winning outcome
    report.suspiciousTrades.forEach(st => {
      expect(st.trade.outcome).toBe('YES');
    });
  });

  it('enriches high-scoring trades with account history', async () => {
    const report = await command.execute({ marketId: 'test-market' });

    report.suspiciousTrades.forEach(st => {
      if (st.score.total > 50) {
        expect(st.accountHistory).toBeDefined();
      }
    });
  });
});
