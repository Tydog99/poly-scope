import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradeDB } from '../../src/db/index.js';
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

  describe('trade saving from subgraph fills', () => {
    it('saves both maker and taker perspectives for each fill', () => {
      // Simulate what analyze.ts does when saving trades
      const fill = {
        id: 'fill-123',
        transactionHash: '0xabc',
        timestamp: 1704067200,
        maker: '0xMaker',
        taker: '0xTaker',
        marketId: 'token-456',
        side: 'Buy' as const,
        size: '1000000000', // 1000 with 6 decimals
        price: '500000', // 0.5 with 6 decimals
      };

      const sizeNum = parseInt(fill.size);
      const priceNum = parseInt(fill.price);
      const valueUsd = Math.round((sizeNum * priceNum) / 1e6);

      const dbTrades = [
        {
          id: `${fill.id}-maker`,
          txHash: fill.transactionHash,
          wallet: fill.maker.toLowerCase(),
          marketId: fill.marketId,
          timestamp: fill.timestamp,
          side: fill.side,
          action: fill.side === 'Buy' ? 'BUY' : 'SELL',
          role: 'maker',
          size: sizeNum,
          price: priceNum,
          valueUsd,
        },
        {
          id: `${fill.id}-taker`,
          txHash: fill.transactionHash,
          wallet: fill.taker.toLowerCase(),
          marketId: fill.marketId,
          timestamp: fill.timestamp,
          side: fill.side,
          action: fill.side === 'Buy' ? 'SELL' : 'BUY',
          role: 'taker',
          size: sizeNum,
          price: priceNum,
          valueUsd,
        },
      ];

      const saved = db.saveTrades(dbTrades);

      expect(saved).toBe(2);
      expect(db.getStatus().trades).toBe(2);
    });

    it('uses composite IDs to avoid conflicts', () => {
      const dbTrades = [
        {
          id: 'fill-123-maker',
          txHash: '0xabc',
          wallet: '0xmaker',
          marketId: 'token-456',
          timestamp: 1704067200,
          side: 'Buy',
          action: 'BUY',
          role: 'maker',
          size: 1000000000,
          price: 500000,
          valueUsd: 500000000,
        },
        {
          id: 'fill-123-taker',
          txHash: '0xabc',
          wallet: '0xtaker',
          marketId: 'token-456',
          timestamp: 1704067200,
          side: 'Buy',
          action: 'SELL',
          role: 'taker',
          size: 1000000000,
          price: 500000,
          valueUsd: 500000000,
        },
      ];

      // First save
      db.saveTrades(dbTrades);
      expect(db.getStatus().trades).toBe(2);

      // Second save (idempotent)
      const saved = db.saveTrades(dbTrades);
      expect(saved).toBe(0); // No new inserts
      expect(db.getStatus().trades).toBe(2);
    });

    it('calculates valueUsd correctly from size and price', () => {
      // size: 1000 shares (1000000000 with 6 decimals)
      // price: 0.5 (500000 with 6 decimals)
      // valueUsd should be 500 (500000000 with 6 decimals)
      const sizeNum = 1000000000;
      const priceNum = 500000;
      const valueUsd = Math.round((sizeNum * priceNum) / 1e6);

      expect(valueUsd).toBe(500000000);
    });

    it('supports querying trades by wallet', () => {
      db.saveTrades([
        {
          id: 'fill-1-maker',
          txHash: '0xabc',
          wallet: '0xalice',
          marketId: 'token-1',
          timestamp: 1000,
          side: 'Buy',
          action: 'BUY',
          role: 'maker',
          size: 100000000,
          price: 500000,
          valueUsd: 50000000,
        },
        {
          id: 'fill-1-taker',
          txHash: '0xabc',
          wallet: '0xbob',
          marketId: 'token-1',
          timestamp: 1000,
          side: 'Buy',
          action: 'SELL',
          role: 'taker',
          size: 100000000,
          price: 500000,
          valueUsd: 50000000,
        },
        {
          id: 'fill-2-taker',
          txHash: '0xdef',
          wallet: '0xalice',
          marketId: 'token-2',
          timestamp: 2000,
          side: 'Sell',
          action: 'BUY',
          role: 'taker',
          size: 200000000,
          price: 600000,
          valueUsd: 120000000,
        },
      ]);

      const aliceTrades = db.getTradesForWallet('0xalice');
      expect(aliceTrades).toHaveLength(2);

      const bobTrades = db.getTradesForWallet('0xbob');
      expect(bobTrades).toHaveLength(1);
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

  describe('point-in-time queries with saved trades', () => {
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

      // Save trades at different timestamps
      db.saveTrades([
        {
          id: 'fill-1-taker',
          txHash: '0xa',
          wallet: '0xtrader',
          marketId: 'token-1',
          timestamp: 1000,
          side: 'Buy',
          action: 'BUY',
          role: 'taker',
          size: 100000000,
          price: 500000,
          valueUsd: 50000000,
        },
        {
          id: 'fill-2-taker',
          txHash: '0xb',
          wallet: '0xtrader',
          marketId: 'token-1',
          timestamp: 2000,
          side: 'Sell',
          action: 'SELL',
          role: 'taker',
          size: 100000000,
          price: 600000,
          valueUsd: 60000000,
        },
        {
          id: 'fill-3-taker',
          txHash: '0xc',
          wallet: '0xtrader',
          marketId: 'token-2',
          timestamp: 3000,
          side: 'Buy',
          action: 'BUY',
          role: 'taker',
          size: 200000000,
          price: 400000,
          valueUsd: 80000000,
        },
      ]);
    });

    it('calculates trade count at point in time', () => {
      expect(db.getAccountStateAt('0xtrader', 1500).tradeCount).toBe(1);
      expect(db.getAccountStateAt('0xtrader', 2500).tradeCount).toBe(2);
      expect(db.getAccountStateAt('0xtrader', 5000).tradeCount).toBe(3);
    });

    it('calculates volume at point in time', () => {
      expect(db.getAccountStateAt('0xtrader', 1500).volume).toBe(50000000);
      expect(db.getAccountStateAt('0xtrader', 2500).volume).toBe(110000000);
      expect(db.getAccountStateAt('0xtrader', 5000).volume).toBe(190000000);
    });

    it('calculates P&L at point in time', () => {
      // At 1500: only BUY, pnl = -50000000
      expect(db.getAccountStateAt('0xtrader', 1500).pnl).toBe(-50000000);
      // At 2500: BUY + SELL, pnl = 60000000 - 50000000 = 10000000
      expect(db.getAccountStateAt('0xtrader', 2500).pnl).toBe(10000000);
      // At 5000: BUY + SELL + BUY, pnl = 60000000 - 50000000 - 80000000 = -70000000
      expect(db.getAccountStateAt('0xtrader', 5000).pnl).toBe(-70000000);
    });

    it('marks as not approximate when full history available', () => {
      expect(db.getAccountStateAt('0xtrader', 2500).approximate).toBe(false);
    });
  });
});
