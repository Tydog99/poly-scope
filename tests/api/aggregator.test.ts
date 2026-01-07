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
});
