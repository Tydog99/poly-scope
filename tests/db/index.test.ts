import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeDB } from '../../src/db/index.js';
import { unlinkSync, existsSync, rmSync } from 'fs';

describe('TradeDB', () => {
  const testDbPath = '.data/test-tradedb.db';
  let tradeDb: TradeDB;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    tradeDb = new TradeDB(testDbPath);
  });

  afterEach(() => {
    tradeDb.close();
    // Clean up WAL files too
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
  });

  describe('initialization', () => {
    it('creates database file', () => {
      expect(existsSync(testDbPath)).toBe(true);
    });

    it('creates .data directory if not exists', () => {
      const nestedPath = '.data/nested/test.db';
      const db = new TradeDB(nestedPath);
      expect(existsSync(nestedPath)).toBe(true);
      db.close();
      rmSync('.data/nested', { recursive: true });
    });
  });

  describe('status', () => {
    it('returns database statistics', () => {
      const status = tradeDb.getStatus();

      expect(status).toEqual({
        path: testDbPath,
        trades: 0,
        accounts: 0,
        redemptions: 0,
        markets: 0,
        backfillQueue: 0,
      });
    });
  });

  describe('trades', () => {
    const mockTrade = {
      id: 'fill-123',
      txHash: '0xabc',
      wallet: '0x123',
      marketId: 'token-456',
      timestamp: 1704067200,
      side: 'Buy',
      action: 'BUY',
      role: 'taker',
      size: 1000000000,
      price: 500000,
      valueUsd: 500000000,
    };

    it('saves a single trade', () => {
      const inserted = tradeDb.saveTrades([mockTrade]);
      expect(inserted).toBe(1);
      expect(tradeDb.getStatus().trades).toBe(1);
    });

    it('is idempotent - saving same trade twice inserts once', () => {
      tradeDb.saveTrades([mockTrade]);
      const inserted = tradeDb.saveTrades([mockTrade]);
      expect(inserted).toBe(0);
      expect(tradeDb.getStatus().trades).toBe(1);
    });

    it('saves multiple trades in a transaction', () => {
      const trades = [
        mockTrade,
        { ...mockTrade, id: 'fill-124', timestamp: 1704067300 },
        { ...mockTrade, id: 'fill-125', timestamp: 1704067400 },
      ];
      const inserted = tradeDb.saveTrades(trades);
      expect(inserted).toBe(3);
    });

    it('retrieves trades for a wallet', () => {
      tradeDb.saveTrades([
        mockTrade,
        { ...mockTrade, id: 'fill-124', wallet: '0x456' },
      ]);
      const trades = tradeDb.getTradesForWallet('0x123');
      expect(trades).toHaveLength(1);
      expect(trades[0].id).toBe('fill-123');
    });

    it('retrieves trades before a timestamp', () => {
      tradeDb.saveTrades([
        { ...mockTrade, id: 'fill-1', timestamp: 1000 },
        { ...mockTrade, id: 'fill-2', timestamp: 2000 },
        { ...mockTrade, id: 'fill-3', timestamp: 3000 },
      ]);
      const trades = tradeDb.getTradesForWallet('0x123', { before: 2500 });
      expect(trades).toHaveLength(2);
      expect(trades.map(t => t.id)).toEqual(['fill-2', 'fill-1']);
    });

    it('retrieves trades for a market', () => {
      tradeDb.saveTrades([
        mockTrade,
        { ...mockTrade, id: 'fill-124', marketId: 'token-789' },
      ]);
      const trades = tradeDb.getTradesForMarket('token-456');
      expect(trades).toHaveLength(1);
    });
  });

  describe('accounts', () => {
    const mockAccount = {
      wallet: '0x123',
      creationTimestamp: 1704067200,
      syncedFrom: 1704067200,
      syncedTo: 1704153600,
      syncedAt: 1704240000,
      tradeCountTotal: 100,
      collateralVolume: 1000000000000,
      profit: 50000000000,
      hasFullHistory: false,
    };

    it('saves an account', () => {
      tradeDb.saveAccount(mockAccount);
      expect(tradeDb.getStatus().accounts).toBe(1);
    });

    it('retrieves an account by wallet', () => {
      tradeDb.saveAccount(mockAccount);
      const account = tradeDb.getAccount('0x123');
      expect(account).not.toBeNull();
      expect(account!.wallet).toBe('0x123');
      expect(account!.tradeCountTotal).toBe(100);
    });

    it('returns null for non-existent account', () => {
      expect(tradeDb.getAccount('0xnonexistent')).toBeNull();
    });

    it('updates existing account on save', () => {
      tradeDb.saveAccount(mockAccount);
      tradeDb.saveAccount({ ...mockAccount, syncedTo: 1704200000 });
      expect(tradeDb.getAccount('0x123')!.syncedTo).toBe(1704200000);
    });

    it('normalizes wallet to lowercase', () => {
      tradeDb.saveAccount({ ...mockAccount, wallet: '0xABC' });
      expect(tradeDb.getAccount('0xabc')).not.toBeNull();
    });

    it('updates sync watermarks', () => {
      tradeDb.saveAccount(mockAccount);
      tradeDb.updateSyncedTo('0x123', 1704300000);
      expect(tradeDb.getAccount('0x123')!.syncedTo).toBe(1704300000);
    });

    it('marks account as complete', () => {
      tradeDb.saveAccount(mockAccount);
      tradeDb.markComplete('0x123');
      expect(tradeDb.getAccount('0x123')!.hasFullHistory).toBe(true);
    });
  });

  describe('point-in-time queries', () => {
    beforeEach(() => {
      tradeDb.saveTrades([
        { id: 'fill-1', txHash: '0xa', wallet: '0x123', marketId: 't1', timestamp: 1000,
          side: 'Buy', action: 'BUY', role: 'taker', size: 100000000, price: 500000, valueUsd: 50000000 },
        { id: 'fill-2', txHash: '0xb', wallet: '0x123', marketId: 't1', timestamp: 2000,
          side: 'Sell', action: 'SELL', role: 'taker', size: 100000000, price: 600000, valueUsd: 60000000 },
        { id: 'fill-3', txHash: '0xc', wallet: '0x123', marketId: 't2', timestamp: 3000,
          side: 'Buy', action: 'BUY', role: 'taker', size: 200000000, price: 400000, valueUsd: 80000000 },
      ]);
      tradeDb.saveAccount({
        wallet: '0x123', creationTimestamp: 500, syncedFrom: 1000, syncedTo: 3000,
        syncedAt: Date.now(), tradeCountTotal: 3, collateralVolume: 190000000,
        profit: 10000000, hasFullHistory: true,
      });
    });

    it('returns trade count at a point in time', () => {
      expect(tradeDb.getAccountStateAt('0x123', 1500).tradeCount).toBe(1);
    });

    it('returns volume at a point in time', () => {
      expect(tradeDb.getAccountStateAt('0x123', 2500).volume).toBe(110000000);
    });

    it('returns all trades when timestamp is after last trade', () => {
      const state = tradeDb.getAccountStateAt('0x123', 5000);
      expect(state.tradeCount).toBe(3);
      expect(state.volume).toBe(190000000);
    });

    it('returns zero when timestamp is before first trade', () => {
      const state = tradeDb.getAccountStateAt('0x123', 500);
      expect(state.tradeCount).toBe(0);
      expect(state.volume).toBe(0);
    });

    it('calculates P&L (sells - buys)', () => {
      expect(tradeDb.getAccountStateAt('0x123', 2500).pnl).toBe(10000000);
    });

    it('marks as approximate when data is incomplete', () => {
      tradeDb.saveAccount({
        wallet: '0x456', creationTimestamp: 500, syncedFrom: 2000, syncedTo: 3000,
        syncedAt: Date.now(), tradeCountTotal: 10, collateralVolume: 100000000,
        profit: 0, hasFullHistory: false,
      });
      expect(tradeDb.getAccountStateAt('0x456', 1500).approximate).toBe(true);
    });

    it('marks as not approximate when data covers the time', () => {
      expect(tradeDb.getAccountStateAt('0x123', 2500).approximate).toBe(false);
    });
  });

  describe('redemptions', () => {
    const mockRedemption = {
      id: 'r-123', wallet: '0x123', conditionId: '0xcond', timestamp: 1704067200, payout: 100000000,
    };

    it('saves redemptions', () => {
      expect(tradeDb.saveRedemptions([mockRedemption])).toBe(1);
      expect(tradeDb.getStatus().redemptions).toBe(1);
    });

    it('is idempotent', () => {
      tradeDb.saveRedemptions([mockRedemption]);
      expect(tradeDb.saveRedemptions([mockRedemption])).toBe(0);
    });

    it('retrieves redemptions for a wallet', () => {
      tradeDb.saveRedemptions([mockRedemption, { ...mockRedemption, id: 'r-456', wallet: '0x456' }]);
      expect(tradeDb.getRedemptionsForWallet('0x123')).toHaveLength(1);
    });
  });

  describe('backfill queue', () => {
    it('queues a wallet for backfill', () => {
      tradeDb.queueBackfill('0x123', 5);
      const queue = tradeDb.getBackfillQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].wallet).toBe('0x123');
    });

    it('orders by priority descending', () => {
      tradeDb.queueBackfill('0x123', 1);
      tradeDb.queueBackfill('0x456', 10);
      tradeDb.queueBackfill('0x789', 5);
      expect(tradeDb.getBackfillQueue().map(q => q.wallet)).toEqual(['0x456', '0x789', '0x123']);
    });

    it('marks backfill as complete', () => {
      tradeDb.queueBackfill('0x123', 1);
      tradeDb.markBackfillComplete('0x123');
      expect(tradeDb.getBackfillQueue()).toHaveLength(0);
    });

    it('checks if wallet has pending backfill', () => {
      expect(tradeDb.hasQueuedBackfill('0x123')).toBe(false);
      tradeDb.queueBackfill('0x123', 1);
      expect(tradeDb.hasQueuedBackfill('0x123')).toBe(true);
    });
  });
});
