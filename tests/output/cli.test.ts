import { describe, it, expect } from 'vitest';
import { CLIReporter } from '../../src/output/cli.js';
import type { AnalysisReport, SuspiciousTrade } from '../../src/output/types.js';

const mockReport: AnalysisReport = {
  market: {
    conditionId: 'test-123',
    questionId: 'q-1',
    question: 'Will X happen?',
    outcomes: ['Yes', 'No'],
    resolutionSource: '',
    endDate: '2024-02-01',
    resolved: true,
    winningOutcome: 'Yes',
  },
  totalTrades: 100,
  analyzedTrades: 45,
  suspiciousTrades: [
    {
      trade: {
        id: 't-1',
        marketId: 'test-123',
        wallet: '0x1a2b3c4d5e6f',
        side: 'BUY',
        outcome: 'YES',
        size: 50000,
        price: 0.12,
        timestamp: new Date('2024-01-15'),
        valueUsd: 6000,
      },
      score: {
        total: 94,
        signals: [
          { name: 'tradeSize', score: 95, weight: 40, details: {} },
          { name: 'accountHistory', score: 90, weight: 35, details: {} },
          { name: 'conviction', score: 98, weight: 25, details: {} },
        ],
        isAlert: true,
      },
      priceImpact: { before: 0.12, after: 0.19, changePercent: 58 },
    },
  ],
  analyzedAt: new Date(),
};

describe('CLIReporter', () => {
  const reporter = new CLIReporter();

  it('formats analysis report', () => {
    const output = reporter.formatAnalysisReport(mockReport);

    expect(output).toContain('Will X happen?');
    expect(output).toContain('Resolved YES');
    expect(output).toContain('94/100');
    expect(output).toContain('0x1a2b...6f');
  });

  it('truncates wallet addresses', () => {
    const truncated = reporter.truncateWallet('0x1234567890abcdef', false);
    expect(truncated).toBe('0x1234...ef');
  });

  it('adds OSC 8 hyperlink when linkable', () => {
    const linked = reporter.truncateWallet('0x1234567890abcdef', true);
    expect(linked).toContain('0x1234...ef');
    expect(linked).toContain('0x1234567890abcdef'); // Full address in link
  });

  it('formats USD values', () => {
    expect(reporter.formatUsd(1234.56)).toBe('$1,235');
    expect(reporter.formatUsd(1000000)).toBe('$1,000,000');
  });
});
