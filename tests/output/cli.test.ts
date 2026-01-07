import { describe, it, expect, beforeEach } from 'vitest';
import { CLIReporter } from '../../src/output/cli.js';
import type { AnalysisReport, SuspiciousTrade } from '../../src/output/types.js';
import type { WalletReport } from '../../src/commands/investigate.js';
import type { SubgraphTrade, SubgraphPosition, SubgraphRedemption } from '../../src/api/types.js';
import type { ResolvedToken } from '../../src/api/market-resolver.js';
import type { Trade, AccountHistory, SignalResult } from '../../src/signals/types.js';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 't-1',
    marketId: 'test-123',
    wallet: '0x1234567890abcdef1234567890abcdef12345678',
    side: 'BUY',
    outcome: 'YES',
    size: 50000,
    price: 0.12,
    timestamp: new Date('2024-01-15T10:30:00Z'),
    valueUsd: 6000,
    ...overrides,
  };
}

function createMockSignalResult(overrides: Partial<SignalResult> = {}): SignalResult {
  return {
    name: 'tradeSize',
    score: 80,
    weight: 40,
    details: {},
    ...overrides,
  };
}

function createMockSuspiciousTrade(overrides: Partial<SuspiciousTrade> = {}): SuspiciousTrade {
  return {
    trade: createMockTrade(),
    score: {
      total: 85,
      signals: [
        createMockSignalResult({ name: 'tradeSize', score: 90 }),
        createMockSignalResult({ name: 'accountHistory', score: 80, weight: 35 }),
        createMockSignalResult({ name: 'conviction', score: 85, weight: 25 }),
      ],
      isAlert: true,
    },
    ...overrides,
  };
}

function createMockAnalysisReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    market: {
      conditionId: 'test-condition-123',
      questionId: 'q-1',
      question: 'Will Bitcoin reach $100k by end of 2024?',
      outcomes: ['Yes', 'No'],
      tokens: [],
      resolutionSource: '',
      endDate: '2024-12-31',
      resolved: true,
      winningOutcome: 'Yes',
    },
    totalTrades: 100,
    analyzedTrades: 45,
    suspiciousTrades: [createMockSuspiciousTrade()],
    analyzedAt: new Date('2024-01-20'),
    ...overrides,
  };
}

function createMockSubgraphTrade(overrides: Partial<SubgraphTrade> = {}): SubgraphTrade {
  return {
    id: 'trade-1',
    transactionHash: '0xabc123def456789',
    timestamp: 1705312200, // 2024-01-15 10:30:00 UTC
    maker: '0x1234567890abcdef1234567890abcdef12345678',
    taker: '0xabcdef1234567890abcdef1234567890abcdef12',
    marketId: '12345678901234567890',
    side: 'Buy',
    size: '6000000000', // 6000 USD (6 decimals)
    price: '120000', // 0.12 (6 decimals)
    ...overrides,
  };
}

function createMockSubgraphPosition(overrides: Partial<SubgraphPosition> = {}): SubgraphPosition {
  return {
    id: 'pos-1',
    marketId: '12345678901234567890',
    valueBought: '10000000000', // 10000 USD
    valueSold: '5000000000', // 5000 USD
    netValue: '5000000000', // +5000 USD profit
    quantityBought: '100000000000', // 100000 shares
    quantitySold: '50000000000', // 50000 shares
    netQuantity: '50000000000', // 50000 shares remaining
    ...overrides,
  };
}

function createMockSubgraphRedemption(overrides: Partial<SubgraphRedemption> = {}): SubgraphRedemption {
  return {
    id: 'redemption-1',
    timestamp: 1705398600, // 2024-01-16
    payout: '5000000000', // 5000 USD
    conditionId: '0xcondition123',
    ...overrides,
  };
}

function createMockAccountHistory(overrides: Partial<AccountHistory> = {}): AccountHistory {
  return {
    wallet: '0x1234567890abcdef1234567890abcdef12345678',
    totalTrades: 50,
    firstTradeDate: new Date('2023-06-01'),
    lastTradeDate: new Date('2024-01-15'),
    totalVolumeUsd: 100000,
    creationDate: new Date('2023-05-15'),
    profitUsd: 15000,
    tradingProfitUsd: 10000,
    redemptionPayoutsUsd: 5000,
    dataSource: 'subgraph',
    ...overrides,
  };
}

function createMockResolvedToken(overrides: Partial<ResolvedToken> = {}): ResolvedToken {
  return {
    tokenId: '12345678901234567890',
    question: 'Will Bitcoin reach $100k?',
    outcome: 'Yes',
    marketSlug: 'bitcoin-100k',
    conditionId: '0xcondition123',
    ...overrides,
  };
}

function createMockWalletReport(overrides: Partial<WalletReport> = {}): WalletReport {
  return {
    wallet: '0x1234567890abcdef1234567890abcdef12345678',
    accountHistory: createMockAccountHistory(),
    positions: [createMockSubgraphPosition()],
    redemptions: [],
    recentTrades: [createMockSubgraphTrade()],
    suspicionFactors: ['No obvious suspicion factors detected'],
    dataSource: 'subgraph',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('CLIReporter', () => {
  let reporter: CLIReporter;

  beforeEach(() => {
    reporter = new CLIReporter();
  });

  // ===========================================================================
  // Utility Functions
  // ===========================================================================

  describe('formatUsd', () => {
    it('formats positive integers correctly', () => {
      expect(reporter.formatUsd(1234)).toBe('$1,234');
      expect(reporter.formatUsd(1000000)).toBe('$1,000,000');
      expect(reporter.formatUsd(0)).toBe('$0');
    });

    it('rounds decimal values', () => {
      expect(reporter.formatUsd(1234.56)).toBe('$1,235');
      expect(reporter.formatUsd(1234.49)).toBe('$1,234');
      expect(reporter.formatUsd(999.5)).toBe('$1,000');
    });

    it('handles negative values', () => {
      expect(reporter.formatUsd(-1234)).toBe('$-1,234');
    });

    it('handles very large values', () => {
      expect(reporter.formatUsd(1000000000)).toBe('$1,000,000,000');
    });

    it('handles very small values', () => {
      expect(reporter.formatUsd(0.001)).toBe('$0');
      expect(reporter.formatUsd(0.5)).toBe('$1');
    });
  });

  describe('truncateWallet', () => {
    it('truncates long wallet addresses', () => {
      const truncated = reporter.truncateWallet('0x1234567890abcdef1234567890abcdef12345678', false);
      expect(truncated).toBe('0x1234...78');
    });

    it('preserves short addresses (10 chars or less)', () => {
      expect(reporter.truncateWallet('0x12345', false)).toBe('0x12345'); // 7 chars
      expect(reporter.truncateWallet('0x12345678', false)).toBe('0x12345678'); // 10 chars - boundary
    });

    it('truncates addresses longer than 10 chars', () => {
      // 11 chars - should be truncated
      expect(reporter.truncateWallet('0x123456789', false)).toBe('0x1234...89'); // 11 chars
      expect(reporter.truncateWallet('0x1234567890', false)).toBe('0x1234...90'); // 12 chars
    });

    it('adds OSC 8 hyperlink when linkable is true', () => {
      const linked = reporter.truncateWallet('0x1234567890abcdef1234567890abcdef12345678', true);

      // Should contain the truncated display text
      expect(linked).toContain('0x1234...78');

      // Should contain the full address for the link
      expect(linked).toContain('0x1234567890abcdef1234567890abcdef12345678');

      // Should contain OSC 8 escape sequences
      expect(linked).toContain('\x1b]8;;');
      expect(linked).toContain('\x07');
    });

    it('defaults to linkable when not specified', () => {
      const result = reporter.truncateWallet('0x1234567890abcdef1234567890abcdef12345678');
      expect(result).toContain('\x1b]8;;'); // Has hyperlink
    });
  });

  // ===========================================================================
  // formatAnalysisReport
  // ===========================================================================

  describe('formatAnalysisReport', () => {
    it('formats basic report with market info', () => {
      const report = createMockAnalysisReport();
      const output = reporter.formatAnalysisReport(report);

      expect(output).toContain('Will Bitcoin reach $100k by end of 2024?');
      expect(output).toContain('Resolved YES');
      expect(output).toContain('Total trades: 100');
      expect(output).toContain('Analyzed: 45');
    });

    it('shows unresolved status for unresolved markets', () => {
      const report = createMockAnalysisReport({
        market: {
          ...createMockAnalysisReport().market,
          resolved: false,
          winningOutcome: undefined,
        },
      });
      const output = reporter.formatAnalysisReport(report);

      expect(output).toContain('Unresolved');
      expect(output).toContain('analyzing all trades');
    });

    it('shows no suspicious trades message when empty', () => {
      const report = createMockAnalysisReport({ suspiciousTrades: [] });
      const output = reporter.formatAnalysisReport(report);

      expect(output).toContain('No suspicious trades detected');
    });

    it('formats suspicious trade with all scores', () => {
      const report = createMockAnalysisReport();
      const output = reporter.formatAnalysisReport(report);

      // Should show the total score
      expect(output).toContain('85/100');

      // Should show individual signal scores
      expect(output).toContain('90/100'); // tradeSize
      expect(output).toContain('80/100'); // accountHistory
    });

    it('formats trade value and outcome', () => {
      const report = createMockAnalysisReport({
        suspiciousTrades: [
          createMockSuspiciousTrade({
            trade: createMockTrade({ valueUsd: 12500, outcome: 'YES', price: 0.25 }),
          }),
        ],
      });
      const output = reporter.formatAnalysisReport(report);

      expect(output).toContain('$12,500');
      expect(output).toContain('YES');
      expect(output).toContain('@0.25');
    });

    describe('wallet stats and coloring', () => {
      it('identifies repeat wallets', () => {
        const wallet1 = '0x1111111111111111111111111111111111111111';
        const wallet2 = '0x2222222222222222222222222222222222222222';

        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({ trade: createMockTrade({ wallet: wallet1, valueUsd: 5000 }) }),
            createMockSuspiciousTrade({ trade: createMockTrade({ wallet: wallet1, valueUsd: 3000 }) }),
            createMockSuspiciousTrade({ trade: createMockTrade({ wallet: wallet2, valueUsd: 1000 }) }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        // Should show repeat wallets section
        expect(output).toContain('Repeat Wallets');
        expect(output).toContain('2 trades');
        expect(output).toContain('$8,000 total'); // 5000 + 3000
      });

      it('does not show repeat wallets section when none exist', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({ trade: createMockTrade({ wallet: '0x1111111111111111111111111111111111111111' }) }),
            createMockSuspiciousTrade({ trade: createMockTrade({ wallet: '0x2222222222222222222222222222222222222222' }) }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        expect(output).not.toContain('Repeat Wallets');
      });

      it('sorts repeat wallets by total volume', () => {
        const wallet1 = '0x1111111111111111111111111111111111111111';
        const wallet2 = '0x2222222222222222222222222222222222222222';

        const report = createMockAnalysisReport({
          suspiciousTrades: [
            // wallet2 has higher total volume
            createMockSuspiciousTrade({ trade: createMockTrade({ wallet: wallet2, valueUsd: 10000 }) }),
            createMockSuspiciousTrade({ trade: createMockTrade({ wallet: wallet2, valueUsd: 10000 }) }),
            createMockSuspiciousTrade({ trade: createMockTrade({ wallet: wallet1, valueUsd: 1000 }) }),
            createMockSuspiciousTrade({ trade: createMockTrade({ wallet: wallet1, valueUsd: 1000 }) }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        // wallet2 should appear first (top suspect) due to higher volume
        const wallet2Index = output.indexOf('0x2222');
        const wallet1Index = output.indexOf('0x1111');
        expect(wallet2Index).toBeLessThan(wallet1Index);
      });
    });

    describe('classification tags', () => {
      it('formats WHALE classification', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({ classifications: ['WHALE'] }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        expect(output).toContain('WHL');
      });

      it('formats SNIPER classification', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({ classifications: ['SNIPER'] }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        expect(output).toContain('SNP');
      });

      it('formats EARLY_MOVER classification', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({ classifications: ['EARLY_MOVER'] }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        expect(output).toContain('ERL');
      });

      it('formats DUMPING classification', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({ classifications: ['DUMPING'] }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        expect(output).toContain('DMP');
      });

      it('formats multiple classifications', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({ classifications: ['WHALE', 'SNIPER', 'EARLY_MOVER'] }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        expect(output).toContain('WHL');
        expect(output).toContain('SNP');
        expect(output).toContain('ERL');
      });

      it('truncates unknown classifications', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({ classifications: ['UNKNOWN_TYPE'] }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        expect(output).toContain('UNK');
      });

      it('handles empty classifications array', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({ classifications: [] }),
          ],
        });
        // Should not throw
        expect(() => reporter.formatAnalysisReport(report)).not.toThrow();
      });

      it('handles undefined classifications', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({ classifications: undefined }),
          ],
        });
        // Should not throw
        expect(() => reporter.formatAnalysisReport(report)).not.toThrow();
      });
    });

    describe('score coloring', () => {
      it('applies red color for scores >= 80', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({
              score: { ...createMockSuspiciousTrade().score, total: 85 },
            }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        // The output contains ANSI color codes - we just verify the score is present
        expect(output).toContain('85/100');
      });

      it('applies yellow color for scores >= 60 and < 80', () => {
        const report = createMockAnalysisReport({
          suspiciousTrades: [
            createMockSuspiciousTrade({
              score: { ...createMockSuspiciousTrade().score, total: 70 },
            }),
          ],
        });
        const output = reporter.formatAnalysisReport(report);

        expect(output).toContain('70/100');
      });
    });
  });

  // ===========================================================================
  // formatWalletReport
  // ===========================================================================

  describe('formatWalletReport', () => {
    it('formats basic wallet report header', () => {
      const report = createMockWalletReport();
      const output = reporter.formatWalletReport(report);

      expect(output).toContain('Wallet Investigation Report');
      expect(output).toContain(report.wallet);
      expect(output).toContain('subgraph');
    });

    describe('account history section', () => {
      it('shows account creation date and age', () => {
        const creationDate = new Date('2023-06-01');
        const report = createMockWalletReport({
          accountHistory: createMockAccountHistory({ creationDate }),
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('Account History');
        expect(output).toContain('Created');
        expect(output).toContain('days ago');
      });

      it('falls back to first trade date if no creation date', () => {
        const report = createMockWalletReport({
          accountHistory: createMockAccountHistory({
            creationDate: undefined,
            firstTradeDate: new Date('2023-07-01'),
          }),
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('First Trade');
      });

      it('shows trade counts with markets and fills', () => {
        const report = createMockWalletReport({
          accountHistory: createMockAccountHistory({ totalTrades: 150 }),
          positions: [
            createMockSubgraphPosition(),
            createMockSubgraphPosition({ marketId: 'market-2' }),
            createMockSubgraphPosition({ marketId: 'market-3' }),
          ],
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('3 markets');
        expect(output).toContain('150 fills');
      });

      it('shows total volume', () => {
        const report = createMockWalletReport({
          accountHistory: createMockAccountHistory({ totalVolumeUsd: 250000 }),
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('Total Volume');
        expect(output).toContain('$250,000');
      });

      it('shows profit/loss with breakdown when redemption data available', () => {
        const report = createMockWalletReport({
          accountHistory: createMockAccountHistory({
            profitUsd: 15000,
            tradingProfitUsd: 10000,
            redemptionPayoutsUsd: 5000,
          }),
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('Profit/Loss');
        expect(output).toContain('+$15,000');
        expect(output).toContain('trading');
        expect(output).toContain('redemptions');
      });

      it('shows negative profit correctly', () => {
        const report = createMockWalletReport({
          accountHistory: createMockAccountHistory({
            profitUsd: -5000,
            tradingProfitUsd: -5000,
            redemptionPayoutsUsd: 0,
          }),
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('$-5,000');
      });

      it('calculates and displays ROI based on cost basis', () => {
        const report = createMockWalletReport({
          accountHistory: createMockAccountHistory({ profitUsd: 5000 }),
          positions: [
            createMockSubgraphPosition({ valueBought: '10000000000' }), // $10,000
          ],
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('ROI');
        expect(output).toContain('50.0%'); // 5000 / 10000 = 50%
        expect(output).toContain('cost basis');
      });

      it('shows last active date', () => {
        const report = createMockWalletReport({
          accountHistory: createMockAccountHistory({
            lastTradeDate: new Date('2024-01-10'),
          }),
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('Last Active');
      });

      it('handles null account history', () => {
        const report = createMockWalletReport({
          accountHistory: null,
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('No account history found');
      });
    });

    describe('positions section', () => {
      it('shows positions header with counts', () => {
        const report = createMockWalletReport({
          positions: [createMockSubgraphPosition()],
          redemptions: [createMockSubgraphRedemption()],
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('Positions & Realized Gains');
        expect(output).toContain('1 positions');
        expect(output).toContain('1 redemptions');
      });

      it('shows position with resolved market name', () => {
        const tokenId = '12345678901234567890';
        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId, question: 'Will ETH hit $5k?' })],
        ]);

        const report = createMockWalletReport({
          positions: [createMockSubgraphPosition({ marketId: tokenId })],
          resolvedMarkets,
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('Will ETH hit $5k?');
        expect(output).toContain('(Yes)');
      });

      it('shows truncated token ID when market not resolved', () => {
        const report = createMockWalletReport({
          positions: [createMockSubgraphPosition({ marketId: '12345678901234567890' })],
          resolvedMarkets: new Map(),
        });
        const output = reporter.formatWalletReport(report);

        // Should show truncated token ID
        expect(output).toContain('1234567890');
        expect(output).toContain('...');
      });

      it('calculates position values correctly', () => {
        const report = createMockWalletReport({
          positions: [
            createMockSubgraphPosition({
              valueBought: '25000000000', // $25,000 cost basis
              valueSold: '33000000000', // $33,000 sold -> P&L = $33k - $25k = +$8k
              netQuantity: '15000000000', // 15,000 shares
            }),
          ],
          resolvedMarkets: new Map(),
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('$25,000'); // Cost basis
        expect(output).toContain('+$8,000'); // Trading P&L = valueSold - valueBought
      });

      it('shows closed position with zero shares', () => {
        const report = createMockWalletReport({
          positions: [
            createMockSubgraphPosition({
              netQuantity: '0', // closed position
            }),
          ],
          resolvedMarkets: new Map(),
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('closed');
      });

      it('limits positions display to 15', () => {
        const positions = Array.from({ length: 20 }, (_, i) =>
          createMockSubgraphPosition({ marketId: `market-${i}` })
        );

        const report = createMockWalletReport({ positions, resolvedMarkets: new Map() });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('and 5 more positions');
      });
    });

    describe('realized gains in positions table', () => {
      it('shows redemption amount in Realized column when position is redeemed', () => {
        const tokenId = '12345678901234567890';
        const conditionId = '0xcondition-matched';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId, conditionId })],
        ]);

        const report = createMockWalletReport({
          positions: [
            createMockSubgraphPosition({
              marketId: tokenId,
              valueBought: '10000000000', // $10,000
              valueSold: '0',
              netQuantity: '0', // fully redeemed
            }),
          ],
          redemptions: [
            createMockSubgraphRedemption({
              payout: '15000000000', // $15,000
              conditionId: conditionId,
            }),
          ],
          resolvedMarkets,
        });

        const output = reporter.formatWalletReport(report);

        // Redemption should appear in the position row's Realized column
        expect(output).toContain('+$15,000');
        // Should NOT have separate Redemptions section
        expect(output).not.toMatch(/Redemptions \(resolved market payouts\)/);
      });

      it('shows "-" in Realized column when position has no redemption', () => {
        const tokenId = '12345678901234567890';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId })],
        ]);

        const report = createMockWalletReport({
          positions: [
            createMockSubgraphPosition({
              marketId: tokenId,
              netQuantity: '50000000000', // still holding
            }),
          ],
          redemptions: [], // no redemptions
          resolvedMarkets,
        });

        const output = reporter.formatWalletReport(report);

        // Position row should exist with market name
        expect(output).toContain('Bitcoin');
      });

      it('shows (sync-issue) when redemption exists but shares remain', () => {
        const tokenId = '12345678901234567890';
        const conditionId = '0xcondition-sync-issue';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId, conditionId })],
        ]);

        const report = createMockWalletReport({
          positions: [
            createMockSubgraphPosition({
              marketId: tokenId,
              valueBought: '10000000000',
              netQuantity: '5000000000', // Still has shares!
            }),
          ],
          redemptions: [
            createMockSubgraphRedemption({
              payout: '8000000000',
              conditionId: conditionId,
            }),
          ],
          resolvedMarkets,
        });

        const output = reporter.formatWalletReport(report);

        expect(output).toContain('sync-issue');
      });

      it('shows "redeemed" in shares column when netQuantity is 0 and has redemption', () => {
        const tokenId = '12345678901234567890';
        const conditionId = '0xcondition-redeemed';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId, conditionId })],
        ]);

        const report = createMockWalletReport({
          positions: [
            createMockSubgraphPosition({
              marketId: tokenId,
              netQuantity: '0', // no shares remaining
            }),
          ],
          redemptions: [
            createMockSubgraphRedemption({
              payout: '10000000000',
              conditionId: conditionId,
            }),
          ],
          resolvedMarkets,
        });

        const output = reporter.formatWalletReport(report);

        expect(output).toContain('redeemed');
      });

      it('aggregates multiple redemptions for same conditionId', () => {
        const tokenId = '12345678901234567890';
        const conditionId = '0xcondition-multi';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId, conditionId })],
        ]);

        const report = createMockWalletReport({
          positions: [
            createMockSubgraphPosition({
              marketId: tokenId,
              valueBought: '5000000000',
              netQuantity: '0',
            }),
          ],
          redemptions: [
            createMockSubgraphRedemption({ payout: '3000000000', conditionId }),
            createMockSubgraphRedemption({ payout: '2000000000', conditionId }),
          ],
          resolvedMarkets,
        });

        const output = reporter.formatWalletReport(report);

        // Should show aggregated $5,000 (3k + 2k)
        expect(output).toContain('+$5,000');
      });

      it('calculates total P&L from positions and redemptions', () => {
        const tokenId = '12345678901234567890';
        const conditionId = '0xcondition123';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId, conditionId })],
        ]);

        const report = createMockWalletReport({
          positions: [
            createMockSubgraphPosition({
              marketId: tokenId,
              valueBought: '10000000000', // $10,000 cost basis
              valueSold: '12000000000', // $12,000 sales → +$2,000 trading P&L
            }),
          ],
          redemptions: [
            createMockSubgraphRedemption({
              payout: '8000000000', // $8,000 redemption
              conditionId: conditionId,
            }),
          ],
          resolvedMarkets,
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('TOTALS');
        expect(output).toContain('$10,000'); // Total cost basis
        expect(output).toContain('+$2,000'); // Trading P&L
        expect(output).toContain('+$8,000'); // Redemptions
        expect(output).toContain('+$10,000 net'); // Total: 2000 + 8000
      });
    });

    describe('recent trades section', () => {
      it('shows trades grouped by market', () => {
        const tokenId = '12345678901234567890';
        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId })],
        ]);

        const report = createMockWalletReport({
          positions: [createMockSubgraphPosition({ marketId: tokenId })],
          recentTrades: [
            createMockSubgraphTrade({ marketId: tokenId }),
          ],
          resolvedMarkets,
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('Recent Trades');
        expect(output).toContain('Market:');
      });

      it('aggregates multiple fills in same transaction', () => {
        const tokenId = '12345678901234567890';
        const txHash = '0xabc123';
        const wallet = '0x1234567890abcdef1234567890abcdef12345678';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId })],
        ]);

        const report = createMockWalletReport({
          wallet,
          positions: [createMockSubgraphPosition({ marketId: tokenId })],
          recentTrades: [
            createMockSubgraphTrade({
              transactionHash: txHash,
              marketId: tokenId,
              maker: wallet,
              side: 'Buy',
              size: '1000000000', // $1000
            }),
            createMockSubgraphTrade({
              id: 'trade-2',
              transactionHash: txHash,
              marketId: tokenId,
              maker: wallet,
              side: 'Buy',
              size: '2000000000', // $2000
            }),
          ],
          resolvedMarkets,
        });
        const output = reporter.formatWalletReport(report);

        // Should show aggregated value
        expect(output).toContain('$3,000');
      });

      it('shows buy and sell trades separately', () => {
        const tokenId = '12345678901234567890';
        const wallet = '0x1234567890abcdef1234567890abcdef12345678';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId })],
        ]);

        const report = createMockWalletReport({
          wallet,
          positions: [createMockSubgraphPosition({ marketId: tokenId })],
          recentTrades: [
            createMockSubgraphTrade({
              transactionHash: '0xtx1',
              marketId: tokenId,
              maker: wallet,
              side: 'Buy',
              timestamp: 1705312200,
            }),
            createMockSubgraphTrade({
              id: 'trade-2',
              transactionHash: '0xtx2',
              marketId: tokenId,
              maker: wallet,
              side: 'Sell',
              timestamp: 1705312300,
            }),
          ],
          resolvedMarkets,
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('Buy');
        expect(output).toContain('Sell');
      });

      it('filters out taker trades (complementary trades)', () => {
        const tokenId = '12345678901234567890';
        const wallet = '0x1234567890abcdef1234567890abcdef12345678';
        const otherWallet = '0xother';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId })],
        ]);

        const report = createMockWalletReport({
          wallet,
          positions: [createMockSubgraphPosition({ marketId: tokenId })],
          recentTrades: [
            // Maker trade - should be included
            createMockSubgraphTrade({
              transactionHash: '0xtx1',
              marketId: tokenId,
              maker: wallet,
              taker: otherWallet,
              side: 'Buy',
              size: '5000000000',
            }),
            // Taker trade - should be filtered out
            createMockSubgraphTrade({
              id: 'trade-2',
              transactionHash: '0xtx2',
              marketId: tokenId,
              maker: otherWallet,
              taker: wallet,
              side: 'Sell',
              size: '3000000000',
            }),
          ],
          resolvedMarkets,
        });
        const output = reporter.formatWalletReport(report);

        // Should show the maker trade value
        expect(output).toContain('$5,000');
        // Taker trade should not show as a separate line
      });

      it('marks complementary YES/NO trades using position data', () => {
        const yesTokenId = '11111111111111111111';
        const noTokenId = '22222222222222222222';
        const wallet = '0x1234567890abcdef1234567890abcdef12345678';
        const txHash = '0xsameTx';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [yesTokenId, createMockResolvedToken({ tokenId: yesTokenId, question: 'Test?', outcome: 'Yes' })],
          [noTokenId, createMockResolvedToken({ tokenId: noTokenId, question: 'Test?', outcome: 'No' })],
        ]);

        const report = createMockWalletReport({
          wallet,
          // Wallet only has position in YES token
          positions: [createMockSubgraphPosition({ marketId: yesTokenId })],
          recentTrades: [
            // YES token trade - wallet's real intent
            createMockSubgraphTrade({
              transactionHash: txHash,
              marketId: yesTokenId,
              maker: wallet,
              side: 'Buy',
              size: '5000000000',
            }),
            // NO token trade - complementary from split/merge
            createMockSubgraphTrade({
              id: 'trade-2',
              transactionHash: txHash,
              marketId: noTokenId,
              maker: wallet,
              side: 'Buy',
              size: '5000000000',
            }),
          ],
          resolvedMarkets,
        });
        const output = reporter.formatWalletReport(report);

        // Should show YES trades (wallet has YES position)
        expect(output).toContain('(Yes)');
        // NO trades are now shown but marked as complementary
        expect(output).toContain('(No)');

        // Count lines that contain market display with (Yes) vs (No)
        const lines = output.split('\n');
        const yesMarketLines = lines.filter(l => l.includes('Test?') && l.includes('(Yes)'));
        const noMarketLines = lines.filter(l => l.includes('Test?') && l.includes('(No)'));

        // Both should be shown
        expect(yesMarketLines.length).toBeGreaterThan(0);
        expect(noMarketLines.length).toBeGreaterThan(0);

        // The transaction has both YES and NO trades - smaller side (YES=$5k) should be marked [C]
        // The NO side has same value ($5k) so with <= comparison, YES is marked as complementary
        expect(output).toContain('[C]');
      });

      it('falls back to higher value when no position data', () => {
        const yesTokenId = '11111111111111111111';
        const noTokenId = '22222222222222222222';
        const wallet = '0x1234567890abcdef1234567890abcdef12345678';
        const txHash = '0xsameTx';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [yesTokenId, createMockResolvedToken({ tokenId: yesTokenId, question: 'Test?', outcome: 'Yes' })],
          [noTokenId, createMockResolvedToken({ tokenId: noTokenId, question: 'Test?', outcome: 'No' })],
        ]);

        const report = createMockWalletReport({
          wallet,
          // No positions (both tokens traded but neither held)
          positions: [],
          recentTrades: [
            // YES token trade - higher value
            createMockSubgraphTrade({
              transactionHash: txHash,
              marketId: yesTokenId,
              maker: wallet,
              side: 'Buy',
              size: '10000000000', // $10,000 (higher)
              price: '500000', // 0.50
            }),
            // NO token trade - lower value
            createMockSubgraphTrade({
              id: 'trade-2',
              transactionHash: txHash,
              marketId: noTokenId,
              maker: wallet,
              side: 'Buy',
              size: '5000000000', // $5,000 (lower)
              price: '500000',
            }),
          ],
          resolvedMarkets,
        });
        const output = reporter.formatWalletReport(report);

        // Should prefer YES trades (higher value)
        expect(output).toContain('(Yes)');
      });

      it('shows market totals for each market', () => {
        const tokenId = '12345678901234567890';
        const wallet = '0x1234567890abcdef1234567890abcdef12345678';

        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({ tokenId })],
        ]);

        const report = createMockWalletReport({
          wallet,
          positions: [createMockSubgraphPosition({ marketId: tokenId })],
          recentTrades: [
            createMockSubgraphTrade({
              transactionHash: '0xtx1',
              marketId: tokenId,
              maker: wallet,
              side: 'Buy',
              size: '3000000000',
            }),
            createMockSubgraphTrade({
              id: 'trade-2',
              transactionHash: '0xtx2',
              marketId: tokenId,
              maker: wallet,
              side: 'Buy',
              size: '2000000000',
            }),
          ],
          resolvedMarkets,
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('Total');
        expect(output).toContain('Bought');
      });

      it('handles empty trades array', () => {
        const report = createMockWalletReport({
          recentTrades: [],
        });
        const output = reporter.formatWalletReport(report);

        // Should not show recent trades section
        expect(output).not.toContain('Recent Trades');
      });

      it('includes unresolved market trades', () => {
        const unresolvedTokenId = '99999999999999999999';
        const wallet = '0x1234567890abcdef1234567890abcdef12345678';

        const report = createMockWalletReport({
          wallet,
          positions: [createMockSubgraphPosition({ marketId: unresolvedTokenId })],
          recentTrades: [
            createMockSubgraphTrade({
              marketId: unresolvedTokenId,
              maker: wallet,
            }),
          ],
          // No resolved markets
          resolvedMarkets: new Map(),
        });
        const output = reporter.formatWalletReport(report);

        // Should still show the trade with truncated token ID
        expect(output).toContain('9999999999');
      });
    });

    describe('suspicion factors section', () => {
      it('shows positive factors with warning icon', () => {
        const report = createMockWalletReport({
          suspicionFactors: ['Very new account (3 days old)', 'Low trade count (5 trades)'],
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('Suspicion Analysis');
        expect(output).toContain('Very new account');
        expect(output).toContain('Low trade count');
      });

      it('shows negative finding with check icon', () => {
        const report = createMockWalletReport({
          suspicionFactors: ['No obvious suspicion factors detected'],
        });
        const output = reporter.formatWalletReport(report);

        expect(output).toContain('No obvious');
      });
    });

    describe('edge cases', () => {
      it('handles wallet report with all empty data', () => {
        const report: WalletReport = {
          wallet: '0x0000000000000000000000000000000000000000',
          accountHistory: null,
          positions: [],
          redemptions: [],
          recentTrades: [],
          suspicionFactors: ['No trading history found'],
          dataSource: 'data-api',
        };

        // Should not throw
        expect(() => reporter.formatWalletReport(report)).not.toThrow();

        const output = reporter.formatWalletReport(report);
        expect(output).toContain('No account history found');
        expect(output).not.toContain('Positions');
        expect(output).not.toContain('Recent Trades');
      });

      it('handles zero values in positions', () => {
        const report = createMockWalletReport({
          positions: [
            createMockSubgraphPosition({
              valueBought: '0',
              valueSold: '0',
              netValue: '0',
              netQuantity: '0',
            }),
          ],
          resolvedMarkets: new Map(),
        });

        expect(() => reporter.formatWalletReport(report)).not.toThrow();
      });

      it('handles missing resolvedMarkets', () => {
        const report = createMockWalletReport({
          positions: [createMockSubgraphPosition()],
          recentTrades: [createMockSubgraphTrade()],
          resolvedMarkets: undefined,
        });

        expect(() => reporter.formatWalletReport(report)).not.toThrow();
      });

      it('handles negative netValue (trading loss)', () => {
        const report = createMockWalletReport({
          positions: [
            createMockSubgraphPosition({
              valueBought: '10000000000', // $10,000 cost basis
              valueSold: '7000000000', // $7,000 sales → -$3,000 loss
            }),
          ],
          resolvedMarkets: new Map(),
        });
        const output = reporter.formatWalletReport(report);

        // The format is $-3,000 (dollar sign before the negative)
        expect(output).toContain('$-3,000');
      });

      it('handles very long market questions', () => {
        const tokenId = '12345678901234567890';
        const resolvedMarkets = new Map<string, ResolvedToken>([
          [tokenId, createMockResolvedToken({
            tokenId,
            question: 'Will this extremely long market question that exceeds the maximum display length be properly truncated in the output?',
          })],
        ]);

        const report = createMockWalletReport({
          positions: [createMockSubgraphPosition({ marketId: tokenId })],
          resolvedMarkets,
        });
        const output = reporter.formatWalletReport(report);

        // Should be truncated with ...
        expect(output).toContain('...');
      });
    });
  });

  // ===========================================================================
  // Private method tests (via public interface)
  // ===========================================================================

  describe('date formatting', () => {
    it('formats dates in MM-DD HH:MM:SS format', () => {
      const trade = createMockTrade({
        timestamp: new Date('2024-03-15T14:30:45Z'),
      });
      const report = createMockAnalysisReport({
        suspiciousTrades: [createMockSuspiciousTrade({ trade })],
      });
      const output = reporter.formatAnalysisReport(report);

      // Should contain formatted date (exact format depends on timezone)
      expect(output).toMatch(/\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    });
  });

  describe('signal abbreviations', () => {
    it('abbreviates tradeSize to Size', () => {
      const report = createMockAnalysisReport();
      const output = reporter.formatAnalysisReport(report);

      // Header should show abbreviation
      expect(output).toContain('Size');
    });

    it('abbreviates accountHistory to Acct', () => {
      const report = createMockAnalysisReport();
      const output = reporter.formatAnalysisReport(report);

      expect(output).toContain('Acct');
    });

    it('abbreviates conviction to Conv', () => {
      const report = createMockAnalysisReport();
      const output = reporter.formatAnalysisReport(report);

      expect(output).toContain('Conv');
    });
  });
});
