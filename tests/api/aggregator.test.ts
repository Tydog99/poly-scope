import { describe, it, expect } from 'vitest';
import { aggregateFills } from '../../src/api/aggregator.js';
import type { SubgraphTrade } from '../../src/api/types.js';

describe('aggregateFills', () => {
  const baseOptions = {
    wallet: '0xinsider',
    tokenToOutcome: new Map([
      ['token-yes', 'YES' as const],
      ['token-no', 'NO' as const],
    ]),
  };

  describe('basic grouping', () => {
    it('groups fills by transaction hash', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell', // Maker sells, so taker buys
          size: '1000000000', // $1000 (6 decimals)
          price: '0.10',
        },
        {
          id: '0xtx1-1',
          transactionHash: '0xtx1',
          timestamp: 1001,
          maker: '0xmaker2',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '2000000000', // $2000
          price: '0.10',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      expect(result).toHaveLength(1);
      expect(result[0].transactionHash).toBe('0xtx1');
      expect(result[0].fillCount).toBe(2);
      expect(result[0].totalValueUsd).toBe(3000);
    });
  });

  describe('price calculation', () => {
    it('calculates weighted average price', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '1000000000', // $1000 at 0.10 = 10000 shares
          price: '0.10',
        },
        {
          id: '0xtx1-1',
          transactionHash: '0xtx1',
          timestamp: 1001,
          maker: '0xmaker2',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '2000000000', // $2000 at 0.20 = 10000 shares
          price: '0.20',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      // Total: $3000, 20000 shares → avg price = $3000/20000 = $0.15
      expect(result[0].avgPrice).toBeCloseTo(0.15, 5);
      expect(result[0].totalSize).toBeCloseTo(20000, 0);
    });
  });

  describe('complementary trade filtering', () => {
    it('filters complementary trades when tx has both YES and NO (smaller value)', () => {
      const fills: SubgraphTrade[] = [
        // YES side: $5000
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '5000000000',
          price: '0.10',
        },
        // NO side: $500 (complementary - smaller)
        {
          id: '0xtx1-1',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker2',
          taker: '0xinsider',
          marketId: 'token-no',
          side: 'Sell',
          size: '500000000',
          price: '0.90',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      // Should only have YES trade, NO filtered as complementary
      expect(result).toHaveLength(1);
      expect(result[0].outcome).toBe('YES');
      expect(result[0].totalValueUsd).toBe(5000);
      expect(result[0].hadComplementaryFills).toBe(true);
      expect(result[0].complementaryValueUsd).toBe(500);
    });

    it('uses position to determine complementary when wallet has YES position', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '1000000000', // $1000 YES
          price: '0.10',
        },
        {
          id: '0xtx1-1',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker2',
          taker: '0xinsider',
          marketId: 'token-no',
          side: 'Sell',
          size: '5000000000', // $5000 NO (larger, but complementary due to position)
          price: '0.90',
        },
      ];

      const optionsWithPosition = {
        ...baseOptions,
        walletPositions: [
          {
            id: 'pos1',
            marketId: 'token-yes',
            valueBought: '10000000000',
            valueSold: '0',
            netValue: '10000000000',
            quantityBought: '100000000000',
            quantitySold: '0',
            netQuantity: '100000000000', // Has YES position
          },
        ],
      };

      const result = aggregateFills(fills, optionsWithPosition);

      // YES should be kept (matches position), NO filtered
      expect(result).toHaveLength(1);
      expect(result[0].outcome).toBe('YES');
      expect(result[0].hadComplementaryFills).toBe(true);
      expect(result[0].complementaryValueUsd).toBe(5000);
    });

    it('prefers maker role over taker when no position data (CLOB cross-matching)', () => {
      // Simulates cross-matched trade: wallet's YES Buy order matched with NO Buy orders
      // Wallet appears as:
      //   - MAKER on YES (their order was filled) - this is their actual intent
      //   - TAKER on NO (counterparty appearance from matching) - artifact
      const fills: SubgraphTrade[] = [
        // YES: wallet is MAKER (placed Buy order)
        {
          id: '0xtx1-yes',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xinsider', // Wallet is maker
          taker: '0xother',
          marketId: 'token-yes',
          side: 'Buy', // Maker's Buy order
          size: '2700000000', // $2700
          price: '0.22',
        },
        // NO: wallet is TAKER (counterparty in cross-match)
        {
          id: '0xtx1-no',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xnobuyer',
          taker: '0xinsider', // Wallet is taker
          marketId: 'token-no',
          side: 'Buy', // NO buyer's order - taker SELLS NO
          size: '9200000000', // $9200 (larger value)
          price: '0.78',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      // Should keep YES (maker role) and filter NO (taker role)
      // even though NO has larger value
      expect(result).toHaveLength(1);
      expect(result[0].outcome).toBe('YES');
      expect(result[0].totalValueUsd).toBe(2700);
      expect(result[0].fills[0].role).toBe('maker');
      expect(result[0].hadComplementaryFills).toBe(true);
      expect(result[0].complementaryValueUsd).toBe(9200);
    });

    it('prefers maker role on NO side when wallet is maker on NO and taker on YES', () => {
      // Opposite scenario: wallet placed NO Buy order
      const fills: SubgraphTrade[] = [
        // YES: wallet is TAKER (counterparty)
        {
          id: '0xtx1-yes',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xyesbuyer',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Buy',
          size: '8000000000', // $8000
          price: '0.22',
        },
        // NO: wallet is MAKER (their actual order)
        {
          id: '0xtx1-no',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xinsider',
          taker: '0xother',
          marketId: 'token-no',
          side: 'Buy',
          size: '3000000000', // $3000 (smaller value)
          price: '0.78',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      // Should keep NO (maker role) and filter YES (taker role)
      expect(result).toHaveLength(1);
      expect(result[0].outcome).toBe('NO');
      expect(result[0].totalValueUsd).toBe(3000);
      expect(result[0].fills[0].role).toBe('maker');
      expect(result[0].hadComplementaryFills).toBe(true);
      expect(result[0].complementaryValueUsd).toBe(8000);
    });

    it('falls back to smaller value when roles are same on both sides', () => {
      // Both are taker fills - use value-based heuristic
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-yes',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '1000000000', // $1000 (smaller)
          price: '0.10',
        },
        {
          id: '0xtx1-no',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker2',
          taker: '0xinsider',
          marketId: 'token-no',
          side: 'Sell',
          size: '5000000000', // $5000 (larger)
          price: '0.90',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      // Both are taker, so falls back to value: keep NO (larger), filter YES (smaller)
      expect(result).toHaveLength(1);
      expect(result[0].outcome).toBe('NO');
      expect(result[0].totalValueUsd).toBe(5000);
      expect(result[0].hadComplementaryFills).toBe(true);
      expect(result[0].complementaryValueUsd).toBe(1000);
    });
  });

  describe('edge cases', () => {
    it('handles single-fill transactions', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '1000000000',
          price: '0.10',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      expect(result).toHaveLength(1);
      expect(result[0].fillCount).toBe(1);
      expect(result[0].fills).toHaveLength(1);
    });

    it('handles empty input', () => {
      const result = aggregateFills([], baseOptions);
      expect(result).toHaveLength(0);
    });

    it('handles multiple separate transactions', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '1000000000',
          price: '0.10',
        },
        {
          id: '0xtx2-0',
          transactionHash: '0xtx2',
          timestamp: 2000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '2000000000',
          price: '0.20',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      expect(result).toHaveLength(2);
      // Should be sorted by timestamp desc
      expect(result[0].transactionHash).toBe('0xtx2');
      expect(result[1].transactionHash).toBe('0xtx1');
    });

    it('correctly determines maker vs taker role', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xinsider', // Wallet is maker
          taker: '0xother',
          marketId: 'token-yes',
          side: 'Sell', // Maker sells
          size: '1000000000',
          price: '0.10',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      expect(result[0].side).toBe('SELL'); // Maker's side matches
      expect(result[0].fills[0].role).toBe('maker');
    });

    it('inverts side for taker', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xother',
          taker: '0xinsider', // Wallet is taker
          marketId: 'token-yes',
          side: 'Sell', // Maker sells, so taker BUYS
          size: '1000000000',
          price: '0.10',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      expect(result[0].side).toBe('BUY'); // Taker's side is opposite
      expect(result[0].fills[0].role).toBe('taker');
    });

    it('prevents double-counting when wallet is both maker and taker in same tx', () => {
      // Real-world case: wallet places limit order that gets filled ($7215 as maker)
      // but also appears as taker in small fills in same tx ($1488 as taker)
      // Should only count the primary (higher value) role
      const fills: SubgraphTrade[] = [
        // Wallet as MAKER - the primary trade ($7215)
        {
          id: '0xtx1-maker',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xinsider',
          taker: '0xother',
          marketId: 'token-yes',
          side: 'Buy', // Maker is buying
          size: '7215000000', // $7215
          price: '0.08',
        },
        // Wallet as TAKER - secondary fills that shouldn't be counted
        {
          id: '0xtx1-taker1',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmarket',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell', // Maker sells, taker buys
          size: '1000000000', // $1000
          price: '0.09',
        },
        {
          id: '0xtx1-taker2',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmarket2',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '488000000', // $488
          price: '0.08',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      // Should only have 1 aggregated trade
      expect(result).toHaveLength(1);

      // Should only include the MAKER fills (higher value = $7215)
      // NOT the taker fills ($1488 total)
      expect(result[0].totalValueUsd).toBe(7215);
      expect(result[0].fillCount).toBe(1);
      expect(result[0].fills[0].role).toBe('maker');
    });
  });
});
