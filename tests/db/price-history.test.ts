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
});
