import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeDB, DBEnrichedOrderFill } from '../../src/db/index.js';
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
        fills: 0,
        accounts: 0,
        redemptions: 0,
        markets: 0,
        backfillQueue: 0,
      });
    });
  });

  describe('fills', () => {
    const mockFill: DBEnrichedOrderFill = {
      id: 'fill-123',
      transactionHash: '0xabc',
      timestamp: 1704067200,
      orderHash: '0xorder123',
      side: 'Buy',
      size: 1000000000,
      price: 500000,
      maker: '0xMaker',
      taker: '0xTaker',
      market: 'token-456',
    };

    it('saves a single fill', () => {
      const inserted = tradeDb.saveFills([mockFill]);
      expect(inserted).toBe(1);
      expect(tradeDb.getStatus().fills).toBe(1);
    });

    it('is idempotent - saving same fill twice inserts once', () => {
      tradeDb.saveFills([mockFill]);
      const inserted = tradeDb.saveFills([mockFill]);
      expect(inserted).toBe(0);
      expect(tradeDb.getStatus().fills).toBe(1);
    });

    it('saves multiple fills in a transaction', () => {
      const fills = [
        mockFill,
        { ...mockFill, id: 'fill-124', timestamp: 1704067300 },
        { ...mockFill, id: 'fill-125', timestamp: 1704067400 },
      ];
      const inserted = tradeDb.saveFills(fills);
      expect(inserted).toBe(3);
    });

    it('retrieves fills where wallet is maker', () => {
      tradeDb.saveFills([
        mockFill,
        { ...mockFill, id: 'fill-124', maker: '0xOther', taker: '0xTaker' },
      ]);
      const fills = tradeDb.getFillsForWallet('0xMaker', { role: 'maker' });
      expect(fills).toHaveLength(1);
      expect(fills[0].id).toBe('fill-123');
    });

    it('retrieves fills where wallet is taker', () => {
      tradeDb.saveFills([
        mockFill,
        { ...mockFill, id: 'fill-124', maker: '0xMaker', taker: '0xOther' },
      ]);
      const fills = tradeDb.getFillsForWallet('0xTaker', { role: 'taker' });
      expect(fills).toHaveLength(1);
      expect(fills[0].id).toBe('fill-123');
    });

    it('retrieves fills where wallet is either maker or taker', () => {
      tradeDb.saveFills([
        { ...mockFill, id: 'fill-1', maker: '0xAlice', taker: '0xBob' },
        { ...mockFill, id: 'fill-2', maker: '0xBob', taker: '0xCharlie' },
        { ...mockFill, id: 'fill-3', maker: '0xCharlie', taker: '0xAlice' },
      ]);
      const fills = tradeDb.getFillsForWallet('0xAlice', { role: 'both' });
      expect(fills).toHaveLength(2);
    });

    it('retrieves fills before a timestamp', () => {
      tradeDb.saveFills([
        { ...mockFill, id: 'fill-1', timestamp: 1000 },
        { ...mockFill, id: 'fill-2', timestamp: 2000 },
        { ...mockFill, id: 'fill-3', timestamp: 3000 },
      ]);
      const fills = tradeDb.getFillsForWallet('0xMaker', { before: 2500, role: 'maker' });
      expect(fills).toHaveLength(2);
      expect(fills.map(f => f.id)).toEqual(['fill-2', 'fill-1']);
    });

    it('retrieves fills for a market', () => {
      tradeDb.saveFills([
        mockFill,
        { ...mockFill, id: 'fill-124', market: 'token-789' },
      ]);
      const fills = tradeDb.getFillsForMarket('token-456');
      expect(fills).toHaveLength(1);
    });

    it('retrieves fills for a market with after filter', () => {
      tradeDb.saveFills([
        { ...mockFill, id: 'fill-1', timestamp: 1000 },
        { ...mockFill, id: 'fill-2', timestamp: 2000 },
        { ...mockFill, id: 'fill-3', timestamp: 3000 },
      ]);
      const fills = tradeDb.getFillsForMarket('token-456', { after: 1500 });
      expect(fills).toHaveLength(2);
      expect(fills.map(f => f.id)).toEqual(['fill-3', 'fill-2']);
    });

    it('retrieves fills for a market with limit', () => {
      tradeDb.saveFills([
        { ...mockFill, id: 'fill-1', timestamp: 1000 },
        { ...mockFill, id: 'fill-2', timestamp: 2000 },
        { ...mockFill, id: 'fill-3', timestamp: 3000 },
      ]);
      const fills = tradeDb.getFillsForMarket('token-456', { limit: 2 });
      expect(fills).toHaveLength(2);
      expect(fills.map(f => f.id)).toEqual(['fill-3', 'fill-2']);
    });

    it('normalizes wallet addresses to lowercase', () => {
      tradeDb.saveFills([mockFill]);
      const fills = tradeDb.getFillsForWallet('0xMAKER', { role: 'maker' });
      expect(fills).toHaveLength(1);
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
    const baseFill: DBEnrichedOrderFill = {
      id: '',
      transactionHash: '',
      timestamp: 0,
      orderHash: '0xorder',
      side: 'Buy',
      size: 0,
      price: 500000,
      maker: '0xmaker',
      taker: '0x123',
      market: 't1',
    };

    beforeEach(() => {
      tradeDb.saveFills([
        { ...baseFill, id: 'fill-1', transactionHash: '0xa', timestamp: 1000, size: 50000000 },
        { ...baseFill, id: 'fill-2', transactionHash: '0xb', timestamp: 2000, size: 60000000 },
        { ...baseFill, id: 'fill-3', transactionHash: '0xc', timestamp: 3000, size: 80000000, market: 't2' },
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

    it('returns pnl as 0 (requires market resolution data)', () => {
      // P&L calculation now requires market resolution data
      expect(tradeDb.getAccountStateAt('0x123', 2500).pnl).toBe(0);
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

    it('respects limit parameter', () => {
      tradeDb.queueBackfill('0x123', 1);
      tradeDb.queueBackfill('0x456', 10);
      tradeDb.queueBackfill('0x789', 5);
      expect(tradeDb.getBackfillQueue(2)).toHaveLength(2);
      expect(tradeDb.getBackfillQueue(2).map(q => q.wallet)).toEqual(['0x456', '0x789']);
    });

    it('sets createdAt timestamp when queuing', () => {
      const before = Math.floor(Date.now() / 1000);
      tradeDb.queueBackfill('0x123', 1);
      const after = Math.floor(Date.now() / 1000);

      const queue = tradeDb.getBackfillQueue();
      expect(queue[0].createdAt).toBeGreaterThanOrEqual(before);
      expect(queue[0].createdAt).toBeLessThanOrEqual(after);
    });

    it('returns priority in queue items', () => {
      tradeDb.queueBackfill('0x123', 42);
      const queue = tradeDb.getBackfillQueue();
      expect(queue[0].priority).toBe(42);
    });
  });

  describe('market sync', () => {
    const mockMarket = {
      tokenId: 'token-123',
      conditionId: 'cond-456',
      question: 'Test market?',
      outcome: 'Yes',
      outcomeIndex: 0,
      resolvedAt: null,
    };

    it('returns null for non-existent market', () => {
      expect(tradeDb.getMarketSync('nonexistent')).toBeNull();
    });

    it('returns sync info for saved market', () => {
      tradeDb.saveMarkets([mockMarket]);
      const sync = tradeDb.getMarketSync('token-123');

      expect(sync).not.toBeNull();
      expect(sync!.tokenId).toBe('token-123');
      expect(sync!.syncedFrom).toBeNull();
      expect(sync!.syncedTo).toBeNull();
      expect(sync!.syncedAt).toBeNull();
      expect(sync!.hasCompleteHistory).toBe(false);
    });

    it('updates syncedFrom', () => {
      tradeDb.saveMarkets([mockMarket]);
      tradeDb.updateMarketSync('token-123', { syncedFrom: 1000 });

      const sync = tradeDb.getMarketSync('token-123');
      expect(sync!.syncedFrom).toBe(1000);
      expect(sync!.syncedAt).not.toBeNull();
    });

    it('updates syncedTo', () => {
      tradeDb.saveMarkets([mockMarket]);
      tradeDb.updateMarketSync('token-123', { syncedTo: 2000 });

      const sync = tradeDb.getMarketSync('token-123');
      expect(sync!.syncedTo).toBe(2000);
    });

    it('updates hasCompleteHistory', () => {
      tradeDb.saveMarkets([mockMarket]);
      tradeDb.updateMarketSync('token-123', { hasCompleteHistory: true });

      const sync = tradeDb.getMarketSync('token-123');
      expect(sync!.hasCompleteHistory).toBe(true);
    });

    it('updates multiple fields at once', () => {
      tradeDb.saveMarkets([mockMarket]);
      tradeDb.updateMarketSync('token-123', {
        syncedFrom: 1000,
        syncedTo: 3000,
        hasCompleteHistory: true,
      });

      const sync = tradeDb.getMarketSync('token-123');
      expect(sync!.syncedFrom).toBe(1000);
      expect(sync!.syncedTo).toBe(3000);
      expect(sync!.hasCompleteHistory).toBe(true);
      expect(sync!.syncedAt).not.toBeNull();
    });

    it('sets syncedAt automatically on update', () => {
      tradeDb.saveMarkets([mockMarket]);
      const before = Math.floor(Date.now() / 1000);
      tradeDb.updateMarketSync('token-123', { syncedTo: 2000 });
      const after = Math.floor(Date.now() / 1000);

      const sync = tradeDb.getMarketSync('token-123');
      expect(sync!.syncedAt).toBeGreaterThanOrEqual(before);
      expect(sync!.syncedAt).toBeLessThanOrEqual(after);
    });

    it('does nothing when no fields provided', () => {
      tradeDb.saveMarkets([mockMarket]);
      tradeDb.updateMarketSync('token-123', {});

      const sync = tradeDb.getMarketSync('token-123');
      expect(sync!.syncedAt).toBeNull();
    });

    it('preserves sync data when saveMarkets is called again', () => {
      // First save with sync data
      tradeDb.saveMarkets([mockMarket]);
      tradeDb.updateMarketSync('token-123', {
        syncedFrom: 1000,
        syncedTo: 5000,
        hasCompleteHistory: true,
      });

      // Re-save with updated metadata
      tradeDb.saveMarkets([{
        ...mockMarket,
        question: 'Updated question?',
        resolvedAt: 1704067200,
      }]);

      // Sync data should be preserved
      const sync = tradeDb.getMarketSync('token-123');
      expect(sync!.syncedFrom).toBe(1000);
      expect(sync!.syncedTo).toBe(5000);
      expect(sync!.hasCompleteHistory).toBe(true);

      // Metadata should be updated
      const market = tradeDb.getMarket('token-123');
      expect(market!.question).toBe('Updated question?');
      expect(market!.resolvedAt).toBe(1704067200);
    });
  });
});
