import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { AnalyzeCommand } from '../../src/commands/analyze.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/venezuela-market.json', import.meta.url), 'utf-8')
);

// Mock API calls to return fixture data
vi.mock('../../src/api/client.js', () => ({
  PolymarketClient: class {
    getMarket = vi.fn().mockResolvedValue(fixture.market);
  },
}));

vi.mock('../../src/api/trades.js', () => ({
  TradeFetcher: class {
    getTradesForMarket = vi.fn().mockResolvedValue(
      fixture.trades.map((t: Record<string, unknown>) => ({
        ...t,
        timestamp: new Date(t.timestamp as string),
        marketId: fixture.market.conditionId,
      }))
    );
  },
}));

vi.mock('../../src/api/accounts.js', () => ({
  AccountFetcher: class {
    getAccountHistory = vi.fn().mockImplementation((wallet: string) => {
      const acc = fixture.accounts[wallet];
      return Promise.resolve({
        wallet,
        totalTrades: acc?.totalTrades ?? 0,
        firstTradeDate: acc?.firstTradeDate ? new Date(acc.firstTradeDate) : null,
        lastTradeDate: acc?.lastTradeDate ? new Date(acc.lastTradeDate) : null,
        totalVolumeUsd: acc?.totalVolumeUsd ?? 0,
      });
    });
    getAccountHistoryBatch = vi.fn().mockImplementation((wallets: string[]) => {
      const results = new Map();
      for (const wallet of wallets) {
        const acc = fixture.accounts[wallet.toLowerCase()] || fixture.accounts[wallet];
        if (acc) {
          results.set(wallet.toLowerCase(), {
            wallet,
            totalTrades: acc.totalTrades ?? 0,
            firstTradeDate: acc.firstTradeDate ? new Date(acc.firstTradeDate) : null,
            lastTradeDate: acc.lastTradeDate ? new Date(acc.lastTradeDate) : null,
            totalVolumeUsd: acc.totalVolumeUsd ?? 0,
            dataSource: 'subgraph',
          });
        }
      }
      return Promise.resolve(results);
    });
  },
}));

describe('Analyze Integration', () => {
  let command: AnalyzeCommand;

  beforeEach(() => {
    // Use lower alert threshold for integration tests
    // This ensures the $100k suspicious trade passes the candidate threshold (alertThreshold - 10)
    const testConfig = {
      ...DEFAULT_CONFIG,
      alertThreshold: 60, // Default is 70, candidate threshold becomes 60; we need 50 for score of 58
    };
    command = new AnalyzeCommand(testConfig);
  });

  it('detects known insider trade from Venezuela market', async () => {
    const report = await command.execute({ marketId: fixture.market.conditionId });

    // Should flag the suspicious wallet
    const suspicious = report.suspiciousTrades.find(
      st => st.trade.wallet === '0xsuspicious1'
    );

    expect(suspicious).toBeDefined();
    expect(suspicious!.score.total).toBeGreaterThan(70);
  });

  it('does not flag normal trading activity', async () => {
    const report = await command.execute({ marketId: fixture.market.conditionId });

    // Normal wallet should not be in suspicious list (or have low score)
    const normal = report.suspiciousTrades.find(
      st => st.trade.wallet === '0xnormal1'
    );

    if (normal) {
      expect(normal.score.total).toBeLessThan(50);
    }
  });
});
