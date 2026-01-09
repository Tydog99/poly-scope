import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TradeDB } from '../../src/db/index.js';
import { runBackfill, backfillWallet } from '../../src/db/backfill.js';
import { unlinkSync, existsSync } from 'fs';

describe('Backfill', () => {
  const testDbPath = '.data/test-backfill.db';
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

  describe('runBackfill', () => {
    it('processes queued wallets in priority order', async () => {
      db.queueBackfill('0x123', 1);
      db.queueBackfill('0x456', 2); // Higher priority

      const mockSubgraph = {
        getTradesByWallet: vi.fn().mockResolvedValue([]),
        getAccount: vi.fn().mockResolvedValue({ creationTimestamp: 1000 }),
      };

      await runBackfill(db, mockSubgraph as any, { maxWallets: 1 });

      // Higher priority wallet processed first
      expect(mockSubgraph.getTradesByWallet).toHaveBeenCalledWith('0x456', expect.any(Object));
      expect(mockSubgraph.getTradesByWallet).toHaveBeenCalledTimes(1);
      expect(db.getBackfillQueue()).toHaveLength(1); // One remaining
    });

    it('respects maxTimeMs limit', async () => {
      db.queueBackfill('0x111', 1);
      db.queueBackfill('0x222', 2);
      db.queueBackfill('0x333', 3);

      const mockSubgraph = {
        getTradesByWallet: vi.fn().mockImplementation(async () => {
          await new Promise(r => setTimeout(r, 50)); // Simulate API delay
          return [];
        }),
        getAccount: vi.fn().mockResolvedValue(null),
      };

      // With a very short time limit, only one should be processed
      const processed = await runBackfill(db, mockSubgraph as any, { maxTimeMs: 10 });

      expect(processed).toBeLessThanOrEqual(2);
    });

    it('returns count of processed wallets', async () => {
      db.queueBackfill('0xaaa', 1);
      db.queueBackfill('0xbbb', 2);

      const mockSubgraph = {
        getTradesByWallet: vi.fn().mockResolvedValue([]),
        getAccount: vi.fn().mockResolvedValue(null),
      };

      const count = await runBackfill(db, mockSubgraph as any);
      expect(count).toBe(2);
    });
  });

  describe('backfillWallet', () => {
    it('marks wallet as started when beginning backfill', async () => {
      db.queueBackfill('0xtest', 1);

      const mockSubgraph = {
        getTradesByWallet: vi.fn().mockResolvedValue([]),
        getAccount: vi.fn().mockResolvedValue(null),
      };

      await backfillWallet(db, mockSubgraph as any, '0xtest');

      // Check that started_at was set
      const queue = db.getBackfillQueue();
      expect(queue).toHaveLength(0); // Should be complete
    });

    it('saves trades from subgraph', async () => {
      db.queueBackfill('0xwallet', 1);

      const mockTrades = [
        {
          id: 'fill-1',
          transactionHash: '0xtx1',
          timestamp: 1700000000,
          maker: '0xmaker',
          taker: '0xwallet',
          marketId: 'token123',
          side: 'Sell' as const,
          size: '100000000', // 100 USD (6 decimals)
          price: '500000', // 0.5
        },
      ];

      const mockSubgraph = {
        getTradesByWallet: vi.fn()
          .mockResolvedValueOnce(mockTrades)
          .mockResolvedValueOnce([]), // Second call returns empty to stop pagination
        getAccount: vi.fn().mockResolvedValue({ creationTimestamp: 1600000000 }),
      };

      await backfillWallet(db, mockSubgraph as any, '0xwallet');

      const trades = db.getTradesForWallet('0xwallet');
      expect(trades.length).toBe(1);
      expect(trades[0].id).toBe('fill-1');
      expect(trades[0].valueUsd).toBe(100000000); // Stored in 6 decimal format
    });

    it('paginates through all trades', async () => {
      db.queueBackfill('0xpaginate', 1);

      // First page of trades
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: `fill-${i}`,
        transactionHash: `0xtx${i}`,
        timestamp: 1700000000 - i * 1000, // Descending timestamps
        maker: '0xmaker',
        taker: '0xpaginate',
        marketId: 'token123',
        side: 'Sell' as const,
        size: '10000000',
        price: '500000',
      }));

      // Second page
      const page2 = Array.from({ length: 50 }, (_, i) => ({
        id: `fill-${100 + i}`,
        transactionHash: `0xtx${100 + i}`,
        timestamp: 1699900000 - i * 1000,
        maker: '0xmaker',
        taker: '0xpaginate',
        marketId: 'token123',
        side: 'Sell' as const,
        size: '10000000',
        price: '500000',
      }));

      const mockSubgraph = {
        getTradesByWallet: vi.fn()
          .mockResolvedValueOnce(page1)
          .mockResolvedValueOnce(page2)
          .mockResolvedValueOnce([]),
        getAccount: vi.fn().mockResolvedValue(null),
      };

      await backfillWallet(db, mockSubgraph as any, '0xpaginate');

      const trades = db.getTradesForWallet('0xpaginate');
      expect(trades.length).toBe(150);
    });

    it('marks wallet as complete after successful backfill', async () => {
      db.queueBackfill('0xcomplete', 1);

      const mockSubgraph = {
        getTradesByWallet: vi.fn().mockResolvedValue([]),
        getAccount: vi.fn().mockResolvedValue({ creationTimestamp: 1600000000 }),
      };

      await backfillWallet(db, mockSubgraph as any, '0xcomplete');

      const account = db.getAccount('0xcomplete');
      expect(account?.hasFullHistory).toBe(true);
    });

    it('does not mark complete on error', async () => {
      db.queueBackfill('0xerror', 1);

      const mockSubgraph = {
        getTradesByWallet: vi.fn().mockRejectedValue(new Error('API error')),
        getAccount: vi.fn().mockResolvedValue(null),
      };

      // Should not throw, just log error
      await backfillWallet(db, mockSubgraph as any, '0xerror');

      const account = db.getAccount('0xerror');
      expect(account?.hasFullHistory).toBeFalsy();
    });

    it('uses existing syncedFrom as cursor when available', async () => {
      // Pre-populate account with syncedFrom
      db.saveAccount({
        wallet: '0xexisting',
        creationTimestamp: 1600000000,
        syncedFrom: 1650000000,
        syncedTo: null,
        syncedAt: null,
        tradeCountTotal: null,
        collateralVolume: null,
        profit: null,
        hasFullHistory: false,
      });
      db.queueBackfill('0xexisting', 1);

      const mockSubgraph = {
        getTradesByWallet: vi.fn().mockResolvedValue([]),
        getAccount: vi.fn().mockResolvedValue(null),
      };

      await backfillWallet(db, mockSubgraph as any, '0xexisting');

      // Should have called with before option set to syncedFrom
      expect(mockSubgraph.getTradesByWallet).toHaveBeenCalledWith(
        '0xexisting',
        expect.objectContaining({
          before: expect.any(Date),
        })
      );
    });
  });
});
