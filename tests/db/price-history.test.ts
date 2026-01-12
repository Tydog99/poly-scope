import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeDB } from '../../src/db/index.js';
import { unlinkSync, existsSync } from 'fs';

describe('Price History DB', () => {
  const testDbPath = '.data/test-prices.db';
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

  it('creates price_history table', () => {
    const status = db.getStatus();
    expect(status).toHaveProperty('priceHistory');
    expect(status.priceHistory).toBe(0);
  });

  describe('savePrices', () => {
    it('saves price points for a token', () => {
      const prices = [
        { timestamp: 1000, price: 0.5 },
        { timestamp: 1060, price: 0.52 },
        { timestamp: 1120, price: 0.55 },
      ];
      const saved = db.savePrices('token-123', prices);
      expect(saved).toBe(3);
      expect(db.getStatus().priceHistory).toBe(3);
    });

    it('is idempotent - same prices saved twice', () => {
      const prices = [{ timestamp: 1000, price: 0.5 }];
      db.savePrices('token-123', prices);
      const saved = db.savePrices('token-123', prices);
      expect(saved).toBe(0);
    });
  });

  describe('getPricesForToken', () => {
    beforeEach(() => {
      db.savePrices('token-123', [
        { timestamp: 1000, price: 0.3 },
        { timestamp: 2000, price: 0.5 },
        { timestamp: 3000, price: 0.7 },
      ]);
    });

    it('returns prices in time range', () => {
      const prices = db.getPricesForToken('token-123', 1500, 2500);
      expect(prices).toHaveLength(1);
      expect(prices[0].timestamp).toBe(2000);
    });

    it('returns empty array for no matches', () => {
      const prices = db.getPricesForToken('token-123', 5000, 6000);
      expect(prices).toEqual([]);
    });

    it('returns all prices when range covers all', () => {
      const prices = db.getPricesForToken('token-123', 0, 10000);
      expect(prices).toHaveLength(3);
    });
  });

  describe('getPriceSyncStatus', () => {
    it('returns undefined bounds for unknown token', () => {
      const status = db.getPriceSyncStatus('unknown');
      expect(status.syncedFrom).toBeUndefined();
      expect(status.syncedTo).toBeUndefined();
    });

    it('returns bounds after saving prices', () => {
      db.savePrices('token-123', [
        { timestamp: 1000, price: 0.3 },
        { timestamp: 3000, price: 0.7 },
      ]);
      const status = db.getPriceSyncStatus('token-123');
      expect(status.syncedFrom).toBe(1000);
      expect(status.syncedTo).toBe(3000);
    });
  });
});
