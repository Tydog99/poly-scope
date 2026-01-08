import { describe, it, expect } from 'vitest';
import { formatMonitorAlert, formatMonitorTrade } from '../../src/output/cli.js';
import type { EvaluatedTrade, RTDSTradeEvent } from '../../src/monitor/types.js';

describe('Monitor Output', () => {
  const mockEvent: RTDSTradeEvent = {
    asset: '123',
    conditionId: 'cond123',
    eventSlug: 'test-event',
    outcome: 'Yes',
    outcomeIndex: 0,
    price: 0.08,
    proxyWallet: '0x31a56e9e690c621ed21de08cb559e9524cdb8ed9',
    side: 'BUY',
    size: 7215,
    slug: 'maduro-yes',
    timestamp: 1704288922,
    transactionHash: '0xtx123',
  };

  const mockEvaluated: EvaluatedTrade = {
    event: mockEvent,
    score: 82,
    isAlert: true,
    signals: {
      tradeSize: { score: 68, weight: 0.4, weighted: 27.2 },
      accountHistory: { score: 95, weight: 0.35, weighted: 33.25 },
      conviction: { score: 86, weight: 0.25, weighted: 21.5 },
    },
    account: {
      wallet: mockEvent.proxyWallet,
      totalTrades: 3,
      firstTradeDate: new Date('2025-12-27'),
      lastTradeDate: new Date('2026-01-03'),
      totalVolumeUsd: 404357,
      dataSource: 'subgraph',
    },
  };

  describe('formatMonitorTrade', () => {
    it('formats verbose trade line', () => {
      const output = formatMonitorTrade(mockEvaluated, false);
      expect(output).toContain('maduro-yes');
      expect(output).toContain('0x31a5');
      expect(output).toContain('BUY');
      expect(output).toContain('577');
      expect(output).toContain('82');
    });
  });

  describe('formatMonitorAlert', () => {
    it('includes market and wallet info', () => {
      const output = formatMonitorAlert(mockEvaluated, 'Will Maduro leave office?');
      expect(output).toContain('ALERT');
      expect(output).toContain('Will Maduro leave office?');
      expect(output).toContain('0x31a5');
    });

    it('includes signal breakdown', () => {
      const output = formatMonitorAlert(mockEvaluated, 'Test Market');
      expect(output).toContain('Trade Size');
      expect(output).toContain('68');
      expect(output).toContain('Account History');
      expect(output).toContain('95');
      expect(output).toContain('Conviction');
      expect(output).toContain('86');
    });
  });
});
