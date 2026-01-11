import { describe, it, expect } from 'vitest';
import { aggregateFillsPerWallet } from '../../src/commands/shared.js';
import type { SubgraphTrade } from '../../src/api/types.js';

describe('aggregateFillsPerWallet', () => {
  const tokenToOutcome = new Map([
    ['token-yes', 'YES' as const],
    ['token-no', 'NO' as const],
  ]);

  describe('maker and taker grouping', () => {
    it('includes fills where wallet is maker', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xwallet1', // Wallet is maker
          taker: '0xother',
          marketId: 'token-yes',
          side: 'Buy',
          size: '5000000000', // $5000
          price: '0.22',
        },
      ];

      const result = aggregateFillsPerWallet(fills, tokenToOutcome);

      // Should have trade for wallet1 (as maker)
      const wallet1Trades = result.filter(t => t.wallet === '0xwallet1');
      expect(wallet1Trades).toHaveLength(1);
      expect(wallet1Trades[0].totalValueUsd).toBe(5000);
      expect(wallet1Trades[0].fills[0].role).toBe('maker');
    });

    it('includes fills where wallet is taker', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xother',
          taker: '0xwallet1', // Wallet is taker
          marketId: 'token-yes',
          side: 'Sell',
          size: '3000000000', // $3000
          price: '0.10',
        },
      ];

      const result = aggregateFillsPerWallet(fills, tokenToOutcome);

      // Should have trade for wallet1 (as taker)
      const wallet1Trades = result.filter(t => t.wallet === '0xwallet1');
      expect(wallet1Trades).toHaveLength(1);
      expect(wallet1Trades[0].totalValueUsd).toBe(3000);
      expect(wallet1Trades[0].fills[0].role).toBe('taker');
    });

    it('includes same fill for both maker and taker wallets', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xwallet1',
          taker: '0xwallet2',
          marketId: 'token-yes',
          side: 'Buy',
          size: '5000000000', // $5000
          price: '0.22',
        },
      ];

      const result = aggregateFillsPerWallet(fills, tokenToOutcome);

      // Should have trades for both wallets
      const wallet1Trades = result.filter(t => t.wallet === '0xwallet1');
      const wallet2Trades = result.filter(t => t.wallet === '0xwallet2');

      expect(wallet1Trades).toHaveLength(1);
      expect(wallet2Trades).toHaveLength(1);

      // wallet1 is maker, wallet2 is taker
      expect(wallet1Trades[0].fills[0].role).toBe('maker');
      expect(wallet2Trades[0].fills[0].role).toBe('taker');
    });
  });

  describe('CLOB cross-matching scenarios', () => {
    it('correctly handles cross-matched transaction with maker on YES and taker on NO', () => {
      // Real-world scenario: wallet placed YES Buy order, got cross-matched with NO Buy orders
      const fills: SubgraphTrade[] = [
        // YES fill: wallet is MAKER (their order)
        {
          id: '0xtx1-yes',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xwallet1', // Wallet placed YES Buy order
          taker: '0xother',
          marketId: 'token-yes',
          side: 'Buy',
          size: '2700000000', // $2700
          price: '0.22',
        },
        // NO fill: wallet is TAKER (counterparty appearance)
        {
          id: '0xtx1-no',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xnobuyer',
          taker: '0xwallet1', // Wallet appears as counterparty
          marketId: 'token-no',
          side: 'Buy',
          size: '9200000000', // $9200
          price: '0.78',
        },
      ];

      const result = aggregateFillsPerWallet(fills, tokenToOutcome);

      // wallet1 should have 1 aggregated trade (YES maker, NO filtered as complementary)
      const wallet1Trades = result.filter(t => t.wallet === '0xwallet1');
      expect(wallet1Trades).toHaveLength(1);
      expect(wallet1Trades[0].outcome).toBe('YES');
      expect(wallet1Trades[0].totalValueUsd).toBe(2700);
      expect(wallet1Trades[0].hadComplementaryFills).toBe(true);
      expect(wallet1Trades[0].complementaryValueUsd).toBe(9200);
    });

    it('handles multiple wallets in cross-matched transaction', () => {
      // Two wallets: one placed YES Buy, one placed NO Buy
      // Cross-matching creates tokens for both
      const fills: SubgraphTrade[] = [
        // YES fill: wallet1 is maker (YES buyer)
        {
          id: '0xtx1-yes',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xwallet1',
          taker: '0xexchange',
          marketId: 'token-yes',
          side: 'Buy',
          size: '2200000000', // $2200
          price: '0.22',
        },
        // NO fill: wallet2 is maker (NO buyer)
        {
          id: '0xtx1-no',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xwallet2',
          taker: '0xexchange',
          marketId: 'token-no',
          side: 'Buy',
          size: '7800000000', // $7800
          price: '0.78',
        },
      ];

      const result = aggregateFillsPerWallet(fills, tokenToOutcome);

      // Each wallet should have their own trade
      const wallet1Trades = result.filter(t => t.wallet === '0xwallet1');
      const wallet2Trades = result.filter(t => t.wallet === '0xwallet2');

      expect(wallet1Trades).toHaveLength(1);
      expect(wallet1Trades[0].outcome).toBe('YES');
      expect(wallet1Trades[0].totalValueUsd).toBe(2200);

      expect(wallet2Trades).toHaveLength(1);
      expect(wallet2Trades[0].outcome).toBe('NO');
      expect(wallet2Trades[0].totalValueUsd).toBe(7800);
    });
  });

  describe('multiple transactions', () => {
    it('aggregates across multiple transactions for same wallet', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xwallet1',
          taker: '0xother',
          marketId: 'token-yes',
          side: 'Buy',
          size: '1000000000', // $1000
          price: '0.10',
        },
        {
          id: '0xtx2-0',
          transactionHash: '0xtx2',
          timestamp: 2000,
          maker: '0xwallet1',
          taker: '0xother',
          marketId: 'token-yes',
          side: 'Buy',
          size: '2000000000', // $2000
          price: '0.20',
        },
      ];

      const result = aggregateFillsPerWallet(fills, tokenToOutcome);

      const wallet1Trades = result.filter(t => t.wallet === '0xwallet1');
      expect(wallet1Trades).toHaveLength(2);

      // Sorted by timestamp desc
      expect(wallet1Trades[0].transactionHash).toBe('0xtx2');
      expect(wallet1Trades[1].transactionHash).toBe('0xtx1');
    });
  });

  describe('edge cases', () => {
    it('handles empty input', () => {
      const result = aggregateFillsPerWallet([], tokenToOutcome);
      expect(result).toHaveLength(0);
    });

    it('handles fills with missing maker', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '', // Empty maker
          taker: '0xwallet1',
          marketId: 'token-yes',
          side: 'Sell',
          size: '1000000000',
          price: '0.10',
        },
      ];

      const result = aggregateFillsPerWallet(fills, tokenToOutcome);

      // Should still include the taker
      const wallet1Trades = result.filter(t => t.wallet === '0xwallet1');
      expect(wallet1Trades).toHaveLength(1);
    });

    it('normalizes wallet addresses to lowercase', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xWALLET1', // Uppercase
          taker: '0xother',
          marketId: 'token-yes',
          side: 'Buy',
          size: '1000000000',
          price: '0.10',
        },
        {
          id: '0xtx2-0',
          transactionHash: '0xtx2',
          timestamp: 2000,
          maker: '0xwallet1', // Lowercase
          taker: '0xother',
          marketId: 'token-yes',
          side: 'Buy',
          size: '2000000000',
          price: '0.20',
        },
      ];

      const result = aggregateFillsPerWallet(fills, tokenToOutcome);

      // Both should be grouped under lowercase wallet
      const wallet1Trades = result.filter(t => t.wallet === '0xwallet1');
      expect(wallet1Trades).toHaveLength(2);
    });
  });
});
