import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradeDB, DBEnrichedOrderFill } from '../../src/db/index.js';
import { unlinkSync, existsSync } from 'fs';

describe('DB Integration', () => {
  const testDbPath = '.data/test-integration.db';
  let db: TradeDB;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    db = new TradeDB(testDbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
  });

  describe('fill saving from subgraph', () => {
    it('saves one fill per EnrichedOrderFilled', () => {
      const fill: DBEnrichedOrderFill = {
        id: 'fill-123',
        transactionHash: '0xabc',
        timestamp: 1704067200,
        orderHash: '0xorder456',
        side: 'Buy',
        size: 1000000000,
        price: 500000,
        maker: '0xMaker',
        taker: '0xTaker',
        market: 'token-456',
      };

      const saved = db.saveFills([fill]);

      expect(saved).toBe(1);
      expect(db.getStatus().fills).toBe(1);
    });

    it('does not duplicate fills', () => {
      const fill: DBEnrichedOrderFill = {
        id: 'fill-123',
        transactionHash: '0xabc',
        timestamp: 1704067200,
        orderHash: '0xorder456',
        side: 'Buy',
        size: 1000000000,
        price: 500000,
        maker: '0xMaker',
        taker: '0xTaker',
        market: 'token-456',
      };

      db.saveFills([fill]);
      const secondSave = db.saveFills([fill]);

      expect(secondSave).toBe(0);
      expect(db.getStatus().fills).toBe(1);
    });

    it('supports querying fills by wallet role', () => {
      db.saveFills([
        {
          id: 'fill-1',
          transactionHash: '0xa',
          timestamp: 1000,
          orderHash: '0xo1',
          side: 'Buy',
          size: 50000000,
          price: 500000,
          maker: '0xalice',
          taker: '0xbob',
          market: 'token-1',
        },
        {
          id: 'fill-2',
          transactionHash: '0xb',
          timestamp: 2000,
          orderHash: '0xo2',
          side: 'Sell',
          size: 60000000,
          price: 600000,
          maker: '0xbob',
          taker: '0xcharlie',
          market: 'token-1',
        },
      ]);

      const aliceMaker = db.getFillsForWallet('0xalice', { role: 'maker' });
      expect(aliceMaker).toHaveLength(1);

      const bobBoth = db.getFillsForWallet('0xbob', { role: 'both' });
      expect(bobBoth).toHaveLength(2);

      const bobTaker = db.getFillsForWallet('0xbob', { role: 'taker' });
      expect(bobTaker).toHaveLength(1);
    });
  });

  describe('redemption saving', () => {
    it('saves redemptions with wallet association', () => {
      const redemptions = [
        {
          id: 'r-123',
          wallet: '0xalice',
          conditionId: '0xcond1',
          timestamp: 1704067200,
          payout: 100000000, // 100 with 6 decimals
        },
        {
          id: 'r-456',
          wallet: '0xbob',
          conditionId: '0xcond1',
          timestamp: 1704067300,
          payout: 50000000,
        },
      ];

      const saved = db.saveRedemptions(redemptions);

      expect(saved).toBe(2);
      expect(db.getStatus().redemptions).toBe(2);
    });

    it('retrieves redemptions by wallet', () => {
      db.saveRedemptions([
        { id: 'r-1', wallet: '0xalice', conditionId: '0xcond1', timestamp: 1000, payout: 100000000 },
        { id: 'r-2', wallet: '0xbob', conditionId: '0xcond1', timestamp: 2000, payout: 50000000 },
        { id: 'r-3', wallet: '0xalice', conditionId: '0xcond2', timestamp: 3000, payout: 75000000 },
      ]);

      const aliceRedemptions = db.getRedemptionsForWallet('0xalice');
      expect(aliceRedemptions).toHaveLength(2);
      expect(aliceRedemptions[0].payout).toBe(75000000); // Most recent first
    });

    it('is idempotent', () => {
      const redemption = {
        id: 'r-123',
        wallet: '0xalice',
        conditionId: '0xcond1',
        timestamp: 1704067200,
        payout: 100000000,
      };

      db.saveRedemptions([redemption]);
      const secondSave = db.saveRedemptions([redemption]);

      expect(secondSave).toBe(0);
      expect(db.getStatus().redemptions).toBe(1);
    });
  });

  describe('market saving', () => {
    it('saves market metadata', () => {
      const markets = [
        {
          tokenId: 'token-yes-123',
          conditionId: '0xcond1',
          question: 'Will X happen?',
          outcome: 'Yes',
          outcomeIndex: 0,
          resolvedAt: null,
        },
        {
          tokenId: 'token-no-123',
          conditionId: '0xcond1',
          question: 'Will X happen?',
          outcome: 'No',
          outcomeIndex: 1,
          resolvedAt: null,
        },
      ];

      const saved = db.saveMarkets(markets);

      expect(saved).toBe(2);
      expect(db.getStatus().markets).toBe(2);
    });

    it('retrieves market by token ID', () => {
      db.saveMarkets([
        {
          tokenId: 'token-yes-123',
          conditionId: '0xcond1',
          question: 'Will X happen?',
          outcome: 'Yes',
          outcomeIndex: 0,
          resolvedAt: null,
        },
      ]);

      const market = db.getMarket('token-yes-123');

      expect(market).not.toBeNull();
      expect(market!.question).toBe('Will X happen?');
      expect(market!.outcome).toBe('Yes');
      expect(market!.outcomeIndex).toBe(0);
    });

    it('returns null for non-existent market', () => {
      expect(db.getMarket('nonexistent')).toBeNull();
    });

    it('updates existing market on re-save', () => {
      db.saveMarkets([
        {
          tokenId: 'token-123',
          conditionId: '0xcond1',
          question: 'Original question?',
          outcome: 'Yes',
          outcomeIndex: 0,
          resolvedAt: null,
        },
      ]);

      db.saveMarkets([
        {
          tokenId: 'token-123',
          conditionId: '0xcond1',
          question: 'Updated question?',
          outcome: 'Yes',
          outcomeIndex: 0,
          resolvedAt: 1704067200,
        },
      ]);

      const market = db.getMarket('token-123');
      expect(market!.question).toBe('Updated question?');
      expect(market!.resolvedAt).toBe(1704067200);
      expect(db.getStatus().markets).toBe(1);
    });
  });

  describe('point-in-time queries with saved fills', () => {
    beforeEach(() => {
      // Set up account with sync info
      db.saveAccount({
        wallet: '0xtrader',
        creationTimestamp: 500,
        syncedFrom: 1000,
        syncedTo: 5000,
        syncedAt: Math.floor(Date.now() / 1000),
        tradeCountTotal: 5,
        collateralVolume: 500000000,
        profit: 50000000,
        hasFullHistory: true,
      });

      // Save market metadata (required for proper volume aggregation)
      db.saveMarkets([
        { tokenId: 'token-1', conditionId: 'cond-1', question: 'Q1?', outcome: 'Yes', outcomeIndex: 0, resolvedAt: null },
        { tokenId: 'token-2', conditionId: 'cond-2', question: 'Q2?', outcome: 'Yes', outcomeIndex: 0, resolvedAt: null },
      ]);

      // Save fills at different timestamps
      // Note: In the new model, each fill is stored once (not per-perspective)
      // The wallet participates as either maker or taker
      db.saveFills([
        {
          id: 'fill-1',
          transactionHash: '0xa',
          timestamp: 1000,
          orderHash: '0xo1',
          side: 'Buy',
          size: 100000000,
          price: 500000,
          maker: '0xmarket-maker',
          taker: '0xtrader',
          market: 'token-1',
        },
        {
          id: 'fill-2',
          transactionHash: '0xb',
          timestamp: 2000,
          orderHash: '0xo2',
          side: 'Sell',
          size: 100000000,
          price: 600000,
          maker: '0xmarket-maker',
          taker: '0xtrader',
          market: 'token-1',
        },
        {
          id: 'fill-3',
          transactionHash: '0xc',
          timestamp: 3000,
          orderHash: '0xo3',
          side: 'Buy',
          size: 200000000,
          price: 400000,
          maker: '0xmarket-maker',
          taker: '0xtrader',
          market: 'token-2',
        },
      ]);
    });

    it('calculates trade count at point in time', () => {
      // getAccountStateAt counts fills where wallet is maker OR taker
      expect(db.getAccountStateAt('0xtrader', 1500).tradeCount).toBe(1);
      expect(db.getAccountStateAt('0xtrader', 2500).tradeCount).toBe(2);
      expect(db.getAccountStateAt('0xtrader', 5000).tradeCount).toBe(3);
    });

    it('calculates volume at point in time', () => {
      // Volume is sum of fill sizes
      expect(db.getAccountStateAt('0xtrader', 1500).volume).toBe(100000000);
      expect(db.getAccountStateAt('0xtrader', 2500).volume).toBe(200000000);
      expect(db.getAccountStateAt('0xtrader', 5000).volume).toBe(400000000);
    });

    it('returns pnl as 0 (requires market resolution data)', () => {
      // P&L calculation now requires market resolution data
      // which is computed in the application layer
      expect(db.getAccountStateAt('0xtrader', 1500).pnl).toBe(0);
      expect(db.getAccountStateAt('0xtrader', 2500).pnl).toBe(0);
      expect(db.getAccountStateAt('0xtrader', 5000).pnl).toBe(0);
    });

    it('marks as not approximate when full history available', () => {
      expect(db.getAccountStateAt('0xtrader', 2500).approximate).toBe(false);
    });
  });

  describe('aggregated volume calculation', () => {
    beforeEach(() => {
      // Save market metadata with YES/NO outcomes for complementary trade detection
      db.saveMarkets([
        { tokenId: 'token-yes', conditionId: 'cond-1', question: 'Q?', outcome: 'Yes', outcomeIndex: 0, resolvedAt: null },
        { tokenId: 'token-no', conditionId: 'cond-1', question: 'Q?', outcome: 'No', outcomeIndex: 1, resolvedAt: null },
      ]);

      db.saveAccount({
        wallet: '0xtrader',
        creationTimestamp: 500,
        syncedFrom: 1000,
        syncedTo: 5000,
        syncedAt: Math.floor(Date.now() / 1000),
        tradeCountTotal: 5,
        collateralVolume: 500000000,
        profit: 50000000,
        hasFullHistory: true,
      });
    });

    it('prevents double-counting when wallet is maker and taker in same tx', () => {
      // Wallet appears as both maker (higher value) and taker (lower value) in same tx
      db.saveFills([
        {
          id: 'fill-maker',
          transactionHash: '0xtx1',
          timestamp: 1000,
          orderHash: '0xo1',
          side: 'Buy',
          size: 7000000000, // $7000 as maker (higher value)
          price: 100000, // 0.1
          maker: '0xtrader',
          taker: '0xother',
          market: 'token-yes',
        },
        {
          id: 'fill-taker',
          transactionHash: '0xtx1',
          timestamp: 1000,
          orderHash: '0xo2',
          side: 'Sell',
          size: 2000000000, // $2000 as taker (lower value)
          price: 100000,
          maker: '0xmarket',
          taker: '0xtrader',
          market: 'token-yes',
        },
      ]);

      const state = db.getAccountStateAt('0xtrader', 2000);

      // Should only count the higher-value role ($7000), not both ($9000)
      expect(state.volume).toBe(7000000000); // $7000 in 6 decimals
      expect(state.tradeCount).toBe(1);
    });

    it('filters complementary trades in same transaction', () => {
      // Wallet buys YES and NO in same tx (like a split operation)
      db.saveFills([
        {
          id: 'fill-yes',
          transactionHash: '0xtx1',
          timestamp: 1000,
          orderHash: '0xo1',
          side: 'Sell', // Taker buys
          size: 5000000000, // $5000 YES
          price: 100000,
          maker: '0xmarket',
          taker: '0xtrader',
          market: 'token-yes',
        },
        {
          id: 'fill-no',
          transactionHash: '0xtx1',
          timestamp: 1000,
          orderHash: '0xo2',
          side: 'Sell', // Taker buys
          size: 500000000, // $500 NO (complementary, smaller)
          price: 900000, // 0.9
          maker: '0xmarket',
          taker: '0xtrader',
          market: 'token-no',
        },
      ]);

      const state = db.getAccountStateAt('0xtrader', 2000);

      // Should only count $5000 YES, not $5500 total (NO is complementary)
      expect(state.volume).toBe(5000000000);
      expect(state.tradeCount).toBe(1);
    });

    it('sums volume correctly across multiple transactions', () => {
      db.saveFills([
        {
          id: 'fill-1',
          transactionHash: '0xtx1',
          timestamp: 1000,
          orderHash: '0xo1',
          side: 'Sell',
          size: 1000000000, // $1000
          price: 500000,
          maker: '0xmarket',
          taker: '0xtrader',
          market: 'token-yes',
        },
        {
          id: 'fill-2',
          transactionHash: '0xtx2',
          timestamp: 2000,
          orderHash: '0xo2',
          side: 'Sell',
          size: 2000000000, // $2000
          price: 500000,
          maker: '0xmarket',
          taker: '0xtrader',
          market: 'token-yes',
        },
      ]);

      const state = db.getAccountStateAt('0xtrader', 3000);

      expect(state.volume).toBe(3000000000); // $3000 total
      expect(state.tradeCount).toBe(2);
    });

    it('marks as approximate when market metadata is missing', () => {
      // Save a fill for a market that's not in the markets table
      db.saveFills([
        {
          id: 'fill-unknown',
          transactionHash: '0xtx1',
          timestamp: 1000,
          orderHash: '0xo1',
          side: 'Sell',
          size: 1000000000,
          price: 500000,
          maker: '0xmarket',
          taker: '0xtrader',
          market: 'unknown-token', // Not in markets table
        },
      ]);

      const state = db.getAccountStateAt('0xtrader', 2000);

      expect(state.approximate).toBe(true);
    });

    it('uses outcomeIndex for YES/NO mapping (not string matching)', () => {
      // Non-binary market with outcomes like "Up"/"Down" instead of "Yes"/"No"
      // outcomeIndex 0 = YES side (first outcome), outcomeIndex 1 = NO side (second outcome)
      db.saveMarkets([
        { tokenId: 'token-up', conditionId: 'cond-range', question: 'Price range?', outcome: 'Up', outcomeIndex: 0, resolvedAt: null },
        { tokenId: 'token-down', conditionId: 'cond-range', question: 'Price range?', outcome: 'Down', outcomeIndex: 1, resolvedAt: null },
      ]);

      // Wallet buys both "Up" (YES side) and "Down" (NO side) in same tx
      db.saveFills([
        {
          id: 'fill-up',
          transactionHash: '0xtx-range',
          timestamp: 1000,
          orderHash: '0xo1',
          side: 'Sell',
          size: 5000000000, // $5000 "Up" (larger = primary)
          price: 100000,
          maker: '0xmarket',
          taker: '0xtrader',
          market: 'token-up',
        },
        {
          id: 'fill-down',
          transactionHash: '0xtx-range',
          timestamp: 1000,
          orderHash: '0xo2',
          side: 'Sell',
          size: 500000000, // $500 "Down" (smaller = complementary)
          price: 900000,
          maker: '0xmarket',
          taker: '0xtrader',
          market: 'token-down',
        },
      ]);

      const state = db.getAccountStateAt('0xtrader', 2000);

      // If using string matching, both "Up" and "Down" would map to YES (neither === "Yes")
      // and complementary filtering wouldn't work. With outcomeIndex, "Up" is YES, "Down" is NO.
      // Should correctly filter "Down" as complementary and count only $5000.
      expect(state.volume).toBe(5000000000);
      expect(state.tradeCount).toBe(1);
    });

    it('excludes fills at the exact query timestamp (exclusive before)', () => {
      // This tests that getAccountStateAt uses < not <= for timestamp
      // We want the state BEFORE the trade, not including it
      db.saveFills([
        {
          id: 'fill-before',
          transactionHash: '0xtx1',
          timestamp: 1000,
          orderHash: '0xo1',
          side: 'Sell',
          size: 1000000000, // $1000
          price: 500000,
          maker: '0xmarket',
          taker: '0xtrader',
          market: 'token-yes',
        },
        {
          id: 'fill-at-query-time',
          transactionHash: '0xtx2',
          timestamp: 2000, // Exactly at query timestamp
          orderHash: '0xo2',
          side: 'Sell',
          size: 5000000000, // $5000
          price: 500000,
          maker: '0xmarket',
          taker: '0xtrader',
          market: 'token-yes',
        },
      ]);

      // Query at timestamp 2000 - should NOT include the $5000 fill at t=2000
      const state = db.getAccountStateAt('0xtrader', 2000);

      expect(state.volume).toBe(1000000000); // Only $1000, not $6000
      expect(state.tradeCount).toBe(1);
    });

    it('returns zero volume for first trade (no prior history)', () => {
      // When a wallet makes their first trade, prior volume should be 0
      db.saveFills([
        {
          id: 'first-trade',
          transactionHash: '0xtx1',
          timestamp: 1000,
          orderHash: '0xo1',
          side: 'Sell',
          size: 5000000000, // $5000
          price: 500000,
          maker: '0xmarket',
          taker: '0xnewwallet',
          market: 'token-yes',
        },
      ]);

      // Query at the trade's timestamp - should have 0 prior volume
      const state = db.getAccountStateAt('0xnewwallet', 1000);

      expect(state.volume).toBe(0);
      expect(state.tradeCount).toBe(0);
    });
  });
});
