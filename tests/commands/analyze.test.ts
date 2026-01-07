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
      createdAt: new Date('2024-01-01').toISOString(),
      tokens: [
        { tokenId: 'yes-token-id', outcome: 'Yes' },
        { tokenId: 'no-token-id', outcome: 'No' },
      ],
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
    transactionHash: 't1',
    marketId: 'test-market',
    wallet: '0xsuspicious',
    side: 'BUY',
    outcome: 'YES',
    totalSize: 50000,
    avgPrice: 0.2, // Low price, should KEPT
    timestamp: new Date('2024-01-15'),
    totalValueUsd: 10000,
    fills: [],
    fillCount: 1,
  },
  {
    transactionHash: 't2',
    marketId: 'test-market',
    wallet: '0xwhale',
    side: 'BUY',
    outcome: 'YES',
    totalSize: 100000,
    avgPrice: 0.98, // High price BUY, should be FILTERED
    timestamp: new Date('2024-01-15'),
    totalValueUsd: 98000,
    fills: [],
    fillCount: 1,
  },
  {
    transactionHash: 't3',
    marketId: 'test-market',
    wallet: '0xseller',
    side: 'SELL',
    outcome: 'YES',
    totalSize: 100000,
    avgPrice: 0.99, // High price SELL, should be FILTERED
    timestamp: new Date('2024-01-15'),
    totalValueUsd: 99000,
    fills: [],
    fillCount: 1,
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
    getAccountHistoryBatch = vi.fn().mockResolvedValue(new Map([
      ['0xsuspicious', {
        wallet: '0xsuspicious',
        totalTrades: 2,
        firstTradeDate: new Date('2024-01-14'),
        lastTradeDate: new Date('2024-01-15'),
        totalVolumeUsd: 10000,
        dataSource: 'subgraph',
      }],
    ]));
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
    const tradeIds = report.suspiciousTrades.map(st => st.trade.transactionHash);
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

    const tradeIds = report.suspiciousTrades.map(st => st.trade.transactionHash);
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

    const tradeIds = report.suspiciousTrades.map(st => st.trade.transactionHash);
    expect(tradeIds).toContain('t1');
    expect(tradeIds).toContain('t2'); // Should be kept now
    expect(tradeIds).toContain('t3'); // Should be kept now
  });
});

// Separate test file would be better for wallet mode tests
// These tests verify the wallet mode aggregation logic in isolation
describe('Wallet mode trade aggregation', () => {
  it('aggregates fills by transaction hash', () => {
    // Test the aggregation logic directly
    const trades = [
      { id: 'tx1-0', outcome: 'YES', valueUsd: 7000, price: 0.08, size: 87500, timestamp: new Date(1704200000000) },
      { id: 'tx1-1', outcome: 'YES', valueUsd: 200, price: 0.08, size: 2500, timestamp: new Date(1704200000000) },
      { id: 'tx1-2', outcome: 'YES', valueUsd: 15, price: 0.08, size: 187.5, timestamp: new Date(1704200000000) },
      { id: 'tx2-0', outcome: 'YES', valueUsd: 6000, price: 0.07, size: 85714, timestamp: new Date(1704100000000) },
    ];

    // Simulate aggregation logic
    const txMap = new Map<string, typeof trades[0]>();
    for (const trade of trades) {
      const txHash = trade.id.includes('-') ? trade.id.split('-')[0] : trade.id;
      const key = `${txHash}|${trade.outcome}`;

      if (!txMap.has(key)) {
        txMap.set(key, { ...trade });
      } else {
        const agg = txMap.get(key)!;
        const newValueUsd = agg.valueUsd + trade.valueUsd;
        agg.price = (agg.price * agg.valueUsd + trade.price * trade.valueUsd) / newValueUsd;
        agg.valueUsd = newValueUsd;
        agg.size += trade.size;
      }
    }

    const aggregated = [...txMap.values()];

    // Should have 2 aggregated trades (tx1 and tx2)
    expect(aggregated.length).toBe(2);

    // tx1 should have combined value
    const tx1 = aggregated.find(t => t.id.startsWith('tx1'));
    expect(tx1?.valueUsd).toBe(7215); // 7000 + 200 + 15

    // tx2 should be unchanged
    const tx2 = aggregated.find(t => t.id.startsWith('tx2'));
    expect(tx2?.valueUsd).toBe(6000);
  });

  it('identifies complementary trades correctly', () => {
    // Simulate complementary detection logic
    const aggregatedTrades = [
      { id: 'tx1-0', outcome: 'YES' as const, valueUsd: 7000 },
      { id: 'tx1-1', outcome: 'NO' as const, valueUsd: 500 },  // Same tx, smaller value = complementary
      { id: 'tx2-0', outcome: 'YES' as const, valueUsd: 6000 },
    ];

    const hasYesPosition = true;
    const hasNoPosition = false;

    // Group by txHash
    const txGroups = new Map<string, { yes?: typeof aggregatedTrades[0], no?: typeof aggregatedTrades[0] }>();
    for (const trade of aggregatedTrades) {
      const txHash = trade.id.includes('-') ? trade.id.split('-')[0] : trade.id;
      if (!txGroups.has(txHash)) {
        txGroups.set(txHash, {});
      }
      const group = txGroups.get(txHash)!;
      if (trade.outcome === 'YES') {
        group.yes = trade;
      } else {
        group.no = trade;
      }
    }

    // Identify complementary
    const complementaryIds = new Set<string>();
    for (const [_txHash, group] of txGroups) {
      if (group.yes && group.no) {
        let complementaryOutcome: 'YES' | 'NO';
        if (hasYesPosition && !hasNoPosition) {
          complementaryOutcome = 'NO';
        } else if (hasNoPosition && !hasYesPosition) {
          complementaryOutcome = 'YES';
        } else {
          complementaryOutcome = group.yes.valueUsd <= group.no.valueUsd ? 'YES' : 'NO';
        }
        const compTrade = complementaryOutcome === 'YES' ? group.yes : group.no;
        complementaryIds.add(compTrade.id);
      }
    }

    // tx1 has both YES and NO, wallet has YES position, so NO is complementary
    expect(complementaryIds.has('tx1-1')).toBe(true);
    expect(complementaryIds.has('tx1-0')).toBe(false);
    expect(complementaryIds.has('tx2-0')).toBe(false);

    // Filter out complementary
    const filtered = aggregatedTrades.filter(t => !complementaryIds.has(t.id));
    expect(filtered.length).toBe(2); // tx1 YES and tx2 YES
  });

  it('filters to maker-only by default', () => {
    const trades = [
      { id: 't1', role: 'maker' as const },
      { id: 't2', role: 'maker' as const },
      { id: 't3', role: 'taker' as const },
      { id: 't4', role: 'taker' as const },
    ];

    const walletRole = 'maker'; // Default for wallet mode
    const filtered = trades.filter(t => t.role === walletRole);

    expect(filtered.length).toBe(2);
    expect(filtered.every(t => t.role === 'maker')).toBe(true);
  });

  it('includes both roles when specified', () => {
    const trades = [
      { id: 't1', role: 'maker' as const },
      { id: 't2', role: 'maker' as const },
      { id: 't3', role: 'taker' as const },
      { id: 't4', role: 'taker' as const },
    ];

    const walletRole = 'both';
    const filtered = walletRole === 'both' ? trades : trades.filter(t => t.role === walletRole);

    expect(filtered.length).toBe(4);
  });
});
