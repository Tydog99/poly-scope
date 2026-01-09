# Trade Database Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace JSON file caching with SQLite to enable point-in-time account state queries and build historical trade data over time.

**Architecture:** SQLite database (`.data/trades.db`) stores trades, accounts, redemptions, and markets. TradeDB class provides the interface. Existing cache classes are replaced. Background backfill handles whale wallets.

**Tech Stack:** `better-sqlite3` for synchronous SQLite access, existing TypeScript/Vitest stack.

---

# Phase 1: Foundation

## Task 1.1: Add better-sqlite3 Dependency

**Files:**
- Modify: `package.json`

**Step 1: Install better-sqlite3**

Run:
```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

**Step 2: Verify installation**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add better-sqlite3 dependency"
```

---

## Task 1.2: Create Database Schema

**Files:**
- Create: `src/db/schema.ts`
- Test: `tests/db/schema.test.ts`

**Step 1: Write the failing test**

Create `tests/db/schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, SCHEMA_VERSION } from '../../src/db/schema.js';
import { unlinkSync, existsSync } from 'fs';

describe('Database Schema', () => {
  const testDbPath = '.data/test-schema.db';
  let db: Database.Database;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    db = new Database(testDbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
  });

  it('creates all required tables', () => {
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('trades');
    expect(tableNames).toContain('accounts');
    expect(tableNames).toContain('redemptions');
    expect(tableNames).toContain('markets');
    expect(tableNames).toContain('backfill_queue');
    expect(tableNames).toContain('schema_version');
  });

  it('creates required indexes', () => {
    initializeSchema(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];

    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_trades_wallet_time');
    expect(indexNames).toContain('idx_trades_market');
    expect(indexNames).toContain('idx_redemptions_wallet');
  });

  it('sets WAL mode for better concurrency', () => {
    initializeSchema(db);

    const result = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe('wal');
  });

  it('tracks schema version', () => {
    initializeSchema(db);

    const version = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number };

    expect(version.version).toBe(SCHEMA_VERSION);
  });

  it('is idempotent - running twice does not error', () => {
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/db/schema.ts`:

```typescript
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

export function initializeSchema(db: Database.Database): void {
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    -- Core trade data (one row per fill)
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      tx_hash TEXT NOT NULL,
      wallet TEXT NOT NULL,
      market_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      side TEXT NOT NULL,
      action TEXT NOT NULL,
      role TEXT NOT NULL,
      size INTEGER NOT NULL,
      price INTEGER NOT NULL,
      value_usd INTEGER NOT NULL
    );

    -- Wallet metadata
    CREATE TABLE IF NOT EXISTS accounts (
      wallet TEXT PRIMARY KEY,
      creation_timestamp INTEGER,
      synced_from INTEGER,
      synced_to INTEGER,
      synced_at INTEGER,
      trade_count_total INTEGER,
      collateral_volume INTEGER,
      profit INTEGER,
      has_full_history INTEGER DEFAULT 0
    );

    -- For profit calculation
    CREATE TABLE IF NOT EXISTS redemptions (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      payout INTEGER NOT NULL
    );

    -- Market metadata cache
    CREATE TABLE IF NOT EXISTS markets (
      token_id TEXT PRIMARY KEY,
      condition_id TEXT,
      question TEXT,
      outcome TEXT,
      outcome_index INTEGER,
      resolved_at INTEGER
    );

    -- Background job queue
    CREATE TABLE IF NOT EXISTS backfill_queue (
      wallet TEXT PRIMARY KEY,
      priority INTEGER DEFAULT 0,
      created_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    );

    -- Indexes for fast queries
    CREATE INDEX IF NOT EXISTS idx_trades_wallet_time ON trades(wallet, timestamp);
    CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_redemptions_wallet ON redemptions(wallet);
  `);

  // Record schema version if not exists
  const existing = db
    .prepare('SELECT version FROM schema_version WHERE version = ?')
    .get(SCHEMA_VERSION);

  if (!existing) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: PASS (5 tests)

**Step 5: Run full test suite**

Run: `npm run test:run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "feat(db): add SQLite schema with trades, accounts, redemptions tables"
```

---

## Task 1.3: Create TradeDB Class - Basic Structure

**Files:**
- Create: `src/db/index.ts`
- Test: `tests/db/index.test.ts`

**Step 1: Write the failing test**

Create `tests/db/index.test.ts`:

```typescript
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
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/index.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/db/index.ts`:

```typescript
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { initializeSchema } from './schema.js';

export interface DBStatus {
  path: string;
  trades: number;
  accounts: number;
  redemptions: number;
  markets: number;
  backfillQueue: number;
}

export class TradeDB {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string = '.data/trades.db') {
    this.dbPath = dbPath;

    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    initializeSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  getStatus(): DBStatus {
    const count = (table: string): number => {
      const result = this.db
        .prepare(`SELECT COUNT(*) as n FROM ${table}`)
        .get() as { n: number };
      return result.n;
    };

    return {
      path: this.dbPath,
      trades: count('trades'),
      accounts: count('accounts'),
      redemptions: count('redemptions'),
      markets: count('markets'),
      backfillQueue: count('backfill_queue'),
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/index.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/db/index.ts tests/db/index.test.ts
git commit -m "feat(db): add TradeDB class with initialization and status"
```

---

## Task 1.4: Add Trade CRUD Operations

**Files:**
- Modify: `src/db/index.ts`
- Modify: `tests/db/index.test.ts`

**Step 1: Write the failing tests**

Add to `tests/db/index.test.ts` inside the main describe block:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/index.test.ts`
Expected: FAIL with "saveTrades is not a function"

**Step 3: Add trade types and methods to `src/db/index.ts`**

Add after DBStatus interface:

```typescript
export interface DBTrade {
  id: string;
  txHash: string;
  wallet: string;
  marketId: string;
  timestamp: number;
  side: string;
  action: string;
  role: string;
  size: number;
  price: number;
  valueUsd: number;
}
```

Add to TradeDB class:

```typescript
  saveTrades(trades: DBTrade[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO trades
      (id, tx_hash, wallet, market_id, timestamp, side, action, role, size, price, value_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;

    const insertMany = this.db.transaction((trades: DBTrade[]) => {
      for (const t of trades) {
        const result = stmt.run(
          t.id, t.txHash, t.wallet.toLowerCase(), t.marketId,
          t.timestamp, t.side, t.action, t.role, t.size, t.price, t.valueUsd
        );
        inserted += result.changes;
      }
    });

    insertMany(trades);
    return inserted;
  }

  getTradesForWallet(wallet: string, options: { before?: number } = {}): DBTrade[] {
    let sql = `
      SELECT id, tx_hash as txHash, wallet, market_id as marketId,
             timestamp, side, action, role, size, price, value_usd as valueUsd
      FROM trades WHERE wallet = ?
    `;
    const params: (string | number)[] = [wallet.toLowerCase()];

    if (options.before) {
      sql += ' AND timestamp < ?';
      params.push(options.before);
    }
    sql += ' ORDER BY timestamp DESC';

    return this.db.prepare(sql).all(...params) as DBTrade[];
  }

  getTradesForMarket(marketId: string): DBTrade[] {
    return this.db.prepare(`
      SELECT id, tx_hash as txHash, wallet, market_id as marketId,
             timestamp, side, action, role, size, price, value_usd as valueUsd
      FROM trades WHERE market_id = ? ORDER BY timestamp DESC
    `).all(marketId) as DBTrade[];
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/index.test.ts`
Expected: PASS (9 tests)

**Step 5: Commit**

```bash
git add src/db/index.ts tests/db/index.test.ts
git commit -m "feat(db): add trade CRUD operations with idempotent inserts"
```

---

## Task 1.5: Add Account CRUD Operations

**Files:**
- Modify: `src/db/index.ts`
- Modify: `tests/db/index.test.ts`

**Step 1: Write the failing tests**

Add to `tests/db/index.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/index.test.ts`
Expected: FAIL with "saveAccount is not a function"

**Step 3: Add account types and methods to `src/db/index.ts`**

Add after DBTrade:

```typescript
export interface DBAccount {
  wallet: string;
  creationTimestamp: number | null;
  syncedFrom: number | null;
  syncedTo: number | null;
  syncedAt: number | null;
  tradeCountTotal: number | null;
  collateralVolume: number | null;
  profit: number | null;
  hasFullHistory: boolean;
}
```

Add to TradeDB class:

```typescript
  saveAccount(account: DBAccount): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO accounts
      (wallet, creation_timestamp, synced_from, synced_to, synced_at,
       trade_count_total, collateral_volume, profit, has_full_history)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      account.wallet.toLowerCase(),
      account.creationTimestamp,
      account.syncedFrom,
      account.syncedTo,
      account.syncedAt,
      account.tradeCountTotal,
      account.collateralVolume,
      account.profit,
      account.hasFullHistory ? 1 : 0
    );
  }

  getAccount(wallet: string): DBAccount | null {
    const row = this.db.prepare(`
      SELECT wallet, creation_timestamp as creationTimestamp,
             synced_from as syncedFrom, synced_to as syncedTo, synced_at as syncedAt,
             trade_count_total as tradeCountTotal, collateral_volume as collateralVolume,
             profit, has_full_history as hasFullHistory
      FROM accounts WHERE wallet = ?
    `).get(wallet.toLowerCase()) as {
      wallet: string; creationTimestamp: number | null;
      syncedFrom: number | null; syncedTo: number | null; syncedAt: number | null;
      tradeCountTotal: number | null; collateralVolume: number | null;
      profit: number | null; hasFullHistory: number;
    } | undefined;

    if (!row) return null;
    return { ...row, hasFullHistory: row.hasFullHistory === 1 };
  }

  updateSyncedTo(wallet: string, timestamp: number): void {
    this.db.prepare(`
      UPDATE accounts SET synced_to = ?, synced_at = strftime('%s', 'now')
      WHERE wallet = ?
    `).run(timestamp, wallet.toLowerCase());
  }

  markComplete(wallet: string): void {
    this.db.prepare(`UPDATE accounts SET has_full_history = 1 WHERE wallet = ?`)
      .run(wallet.toLowerCase());
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/index.test.ts`
Expected: PASS (16 tests)

**Step 5: Commit**

```bash
git add src/db/index.ts tests/db/index.test.ts
git commit -m "feat(db): add account CRUD with sync watermarks"
```

---

## Task 1.6: Add Point-in-Time Query

**Files:**
- Modify: `src/db/index.ts`
- Modify: `tests/db/index.test.ts`

**Step 1: Write the failing tests**

Add to `tests/db/index.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/index.test.ts`
Expected: FAIL with "getAccountStateAt is not a function"

**Step 3: Add point-in-time method to `src/db/index.ts`**

Add after DBAccount:

```typescript
export interface PointInTimeState {
  tradeCount: number;
  volume: number;
  pnl: number;
  approximate: boolean;
}
```

Add to TradeDB class:

```typescript
  getAccountStateAt(wallet: string, atTimestamp: number): PointInTimeState {
    const account = this.getAccount(wallet);
    const approximate = !account || !account.hasFullHistory ||
      (account.syncedFrom !== null && account.syncedFrom > atTimestamp);

    const result = this.db.prepare(`
      SELECT COUNT(*) as tradeCount, COALESCE(SUM(value_usd), 0) as volume,
        COALESCE(SUM(CASE WHEN action = 'SELL' THEN value_usd ELSE 0 END) -
                 SUM(CASE WHEN action = 'BUY' THEN value_usd ELSE 0 END), 0) as pnl
      FROM trades WHERE wallet = ? AND timestamp < ?
    `).get(wallet.toLowerCase(), atTimestamp) as { tradeCount: number; volume: number; pnl: number };

    return { ...result, approximate };
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/index.test.ts`
Expected: PASS (23 tests)

**Step 5: Commit**

```bash
git add src/db/index.ts tests/db/index.test.ts
git commit -m "feat(db): add point-in-time account state queries"
```

---

## Task 1.7: Add Redemption and Backfill Queue Operations

**Files:**
- Modify: `src/db/index.ts`
- Modify: `tests/db/index.test.ts`

**Step 1: Write the failing tests**

Add to `tests/db/index.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/index.test.ts`
Expected: FAIL

**Step 3: Add redemption and backfill methods to `src/db/index.ts`**

Add types after PointInTimeState:

```typescript
export interface DBRedemption {
  id: string;
  wallet: string;
  conditionId: string;
  timestamp: number;
  payout: number;
}

export interface BackfillQueueItem {
  wallet: string;
  priority: number;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
}
```

Add to TradeDB class:

```typescript
  saveRedemptions(redemptions: DBRedemption[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO redemptions (id, wallet, condition_id, timestamp, payout)
      VALUES (?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const insertMany = this.db.transaction((redemptions: DBRedemption[]) => {
      for (const r of redemptions) {
        inserted += stmt.run(r.id, r.wallet.toLowerCase(), r.conditionId, r.timestamp, r.payout).changes;
      }
    });
    insertMany(redemptions);
    return inserted;
  }

  getRedemptionsForWallet(wallet: string): DBRedemption[] {
    return this.db.prepare(`
      SELECT id, wallet, condition_id as conditionId, timestamp, payout
      FROM redemptions WHERE wallet = ? ORDER BY timestamp DESC
    `).all(wallet.toLowerCase()) as DBRedemption[];
  }

  queueBackfill(wallet: string, priority: number = 0): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO backfill_queue (wallet, priority, created_at, started_at, completed_at)
      VALUES (?, ?, strftime('%s', 'now'), NULL, NULL)
    `).run(wallet.toLowerCase(), priority);
  }

  getBackfillQueue(limit?: number): BackfillQueueItem[] {
    let sql = `
      SELECT wallet, priority, created_at as createdAt, started_at as startedAt, completed_at as completedAt
      FROM backfill_queue WHERE completed_at IS NULL ORDER BY priority DESC, created_at ASC
    `;
    if (limit) sql += ` LIMIT ${limit}`;
    return this.db.prepare(sql).all() as BackfillQueueItem[];
  }

  markBackfillStarted(wallet: string): void {
    this.db.prepare(`UPDATE backfill_queue SET started_at = strftime('%s', 'now') WHERE wallet = ?`)
      .run(wallet.toLowerCase());
  }

  markBackfillComplete(wallet: string): void {
    this.db.prepare(`UPDATE backfill_queue SET completed_at = strftime('%s', 'now') WHERE wallet = ?`)
      .run(wallet.toLowerCase());
  }

  hasQueuedBackfill(wallet: string): boolean {
    return this.db.prepare(`SELECT 1 FROM backfill_queue WHERE wallet = ? AND completed_at IS NULL`)
      .get(wallet.toLowerCase()) !== undefined;
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/index.test.ts`
Expected: PASS (30+ tests)

**Step 5: Commit**

```bash
git add src/db/index.ts tests/db/index.test.ts
git commit -m "feat(db): add redemption and backfill queue operations"
```

---

## Task 1.8: Add CLI Commands (`db status`, `db wallet`)

**Files:**
- Modify: `src/index.ts`

**Step 1: Add db command group**

Add after the monitor command in `src/index.ts`:

```typescript
// DB management commands
const dbCommand = program.command('db').description('Database management commands');

dbCommand
  .command('status')
  .description('Show database statistics')
  .action(async () => {
    const { TradeDB } = await import('./db/index.js');
    const db = new TradeDB();
    const status = db.getStatus();
    const { statSync } = await import('fs');
    const sizeMB = (statSync(status.path).size / 1024 / 1024).toFixed(2);

    console.log(`Database: ${status.path} (${sizeMB} MB)`);
    console.log(`Trades: ${status.trades.toLocaleString()}`);
    console.log(`Accounts: ${status.accounts.toLocaleString()}`);
    console.log(`Redemptions: ${status.redemptions.toLocaleString()}`);
    console.log(`Markets: ${status.markets.toLocaleString()}`);
    console.log(`Backfill queue: ${status.backfillQueue}`);
    db.close();
  });

dbCommand
  .command('wallet <address>')
  .description('Show database info for a wallet')
  .action(async (address: string) => {
    const { TradeDB } = await import('./db/index.js');
    const db = new TradeDB();
    const account = db.getAccount(address);

    if (!account) {
      console.log(`Wallet ${address} not found in database`);
      db.close();
      return;
    }

    console.log(`Wallet: ${account.wallet}`);
    console.log(`Created: ${account.creationTimestamp ? new Date(account.creationTimestamp * 1000).toISOString() : 'unknown'}`);
    console.log(`Synced: ${account.syncedFrom ? new Date(account.syncedFrom * 1000).toISOString() : 'never'} to ${account.syncedTo ? new Date(account.syncedTo * 1000).toISOString() : 'never'}`);
    console.log(`Trades in DB: ${db.getTradesForWallet(address).length}`);
    console.log(`Complete: ${account.hasFullHistory ? 'Yes' : 'No'}`);
    if (db.hasQueuedBackfill(address)) console.log(`Backfill: Queued`);
    db.close();
  });
```

**Step 2: Test manually**

Run: `npm run build && ./dist/index.js db status`
Expected: Shows database stats

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): add 'db status' and 'db wallet' commands"
```

---

# Phase 2: Migration

## Task 2.1: Create Migration Module

**Files:**
- Create: `src/db/migrate.ts`
- Test: `tests/db/migrate.test.ts`

**Step 1: Write the failing test**

Create `tests/db/migrate.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradeDB } from '../../src/db/index.js';
import { importJsonCaches, validateMigration, MigrationResult } from '../../src/db/migrate.js';
import { unlinkSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';

describe('Migration', () => {
  const testDbPath = '.data/test-migrate.db';
  const testCacheDir = '.test-cache';
  let db: TradeDB;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(testCacheDir)) rmSync(testCacheDir, { recursive: true });
    db = new TradeDB(testDbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
    if (existsSync(testCacheDir)) rmSync(testCacheDir, { recursive: true });
  });

  describe('importJsonCaches', () => {
    it('imports trades from JSON cache files', () => {
      mkdirSync(`${testCacheDir}/trades`, { recursive: true });
      writeFileSync(`${testCacheDir}/trades/market-123.json`, JSON.stringify({
        marketId: 'market-123',
        trades: [
          { transactionHash: 'tx1', wallet: '0x123', marketId: 'token-1', timestamp: '2024-01-01T00:00:00.000Z',
            side: 'Buy', action: 'BUY', role: 'taker', totalSize: 100, avgPrice: 0.5, totalValueUsd: 50,
            fills: [{ id: 'fill-1', size: 100, price: 0.5, valueUsd: 50, timestamp: '2024-01-01T00:00:00.000Z' }] },
        ],
      }));

      const result = importJsonCaches(db, testCacheDir);

      expect(result.trades).toBe(1);
      expect(db.getStatus().trades).toBe(1);
    });

    it('imports accounts from JSON cache files', () => {
      mkdirSync(`${testCacheDir}/accounts`, { recursive: true });
      writeFileSync(`${testCacheDir}/accounts/0x123.json`, JSON.stringify({
        wallet: '0x123', totalTrades: 10, totalVolumeUsd: 1000,
        firstTradeDate: '2024-01-01T00:00:00.000Z', lastTradeDate: '2024-01-02T00:00:00.000Z',
        creationDate: '2023-12-31T00:00:00.000Z', profitUsd: 50,
      }));

      const result = importJsonCaches(db, testCacheDir);

      expect(result.accounts).toBe(1);
      expect(db.getAccount('0x123')).not.toBeNull();
    });

    it('is idempotent - running twice imports once', () => {
      mkdirSync(`${testCacheDir}/accounts`, { recursive: true });
      writeFileSync(`${testCacheDir}/accounts/0x123.json`, JSON.stringify({
        wallet: '0x123', totalTrades: 10, totalVolumeUsd: 1000,
        firstTradeDate: null, lastTradeDate: null,
      }));

      importJsonCaches(db, testCacheDir);
      const result = importJsonCaches(db, testCacheDir);

      expect(result.accounts).toBe(0); // Already imported
    });
  });

  describe('validateMigration', () => {
    it('returns valid when counts match', () => {
      mkdirSync(`${testCacheDir}/accounts`, { recursive: true });
      writeFileSync(`${testCacheDir}/accounts/0x123.json`, JSON.stringify({
        wallet: '0x123', totalTrades: 10, totalVolumeUsd: 1000,
        firstTradeDate: null, lastTradeDate: null,
      }));

      importJsonCaches(db, testCacheDir);
      const validation = validateMigration(db, testCacheDir);

      expect(validation.valid).toBe(true);
      expect(validation.dbCounts.accounts).toBe(1);
      expect(validation.jsonCounts.accounts).toBe(1);
    });

    it('returns invalid when DB has fewer records', () => {
      mkdirSync(`${testCacheDir}/accounts`, { recursive: true });
      writeFileSync(`${testCacheDir}/accounts/0x123.json`, JSON.stringify({
        wallet: '0x123', totalTrades: 10, totalVolumeUsd: 1000,
        firstTradeDate: null, lastTradeDate: null,
      }));

      // Don't import - DB is empty
      const validation = validateMigration(db, testCacheDir);

      expect(validation.valid).toBe(false);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/migrate.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Implement migration module**

Create `src/db/migrate.ts`:

```typescript
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TradeDB, DBTrade, DBRedemption } from './index.js';

export interface MigrationResult {
  trades: number;
  accounts: number;
  redemptions: number;
  errors: string[];
}

export interface ValidationResult {
  valid: boolean;
  dbCounts: { trades: number; accounts: number; redemptions: number };
  jsonCounts: { trades: number; accounts: number; redemptions: number };
  warnings: string[];
}

interface JsonTrade {
  transactionHash: string;
  wallet: string;
  marketId: string;
  timestamp: string;
  side: string;
  action: string;
  role: string;
  totalSize: number;
  avgPrice: number;
  totalValueUsd: number;
  fills: Array<{ id: string; size: number; price: number; valueUsd: number; timestamp: string }>;
}

interface JsonAccount {
  wallet: string;
  totalTrades: number;
  totalVolumeUsd: number;
  firstTradeDate: string | null;
  lastTradeDate: string | null;
  creationDate?: string;
  profitUsd?: number;
}

interface JsonRedemption {
  id: string;
  wallet: string;
  conditionId: string;
  timestamp: string;
  payout: number;
}

export function importJsonCaches(db: TradeDB, cacheDir: string = '.cache'): MigrationResult {
  const result: MigrationResult = { trades: 0, accounts: 0, redemptions: 0, errors: [] };

  // Import trades
  const tradesDir = join(cacheDir, 'trades');
  if (existsSync(tradesDir)) {
    for (const file of readdirSync(tradesDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(tradesDir, file), 'utf-8'));
        const trades: DBTrade[] = (data.trades || []).flatMap((t: JsonTrade) =>
          t.fills.map(f => ({
            id: f.id,
            txHash: t.transactionHash,
            wallet: t.wallet,
            marketId: t.marketId,
            timestamp: Math.floor(new Date(f.timestamp).getTime() / 1000),
            side: t.side,
            action: t.action,
            role: t.role,
            size: Math.round(f.size * 1e6),
            price: Math.round(f.price * 1e6),
            valueUsd: Math.round(f.valueUsd * 1e6),
          }))
        );
        result.trades += db.saveTrades(trades);
      } catch (e) {
        result.errors.push(`Failed to import ${file}: ${(e as Error).message}`);
      }
    }
  }

  // Import accounts
  const accountsDir = join(cacheDir, 'accounts');
  if (existsSync(accountsDir)) {
    for (const file of readdirSync(accountsDir).filter(f => f.endsWith('.json'))) {
      try {
        const data: JsonAccount = JSON.parse(readFileSync(join(accountsDir, file), 'utf-8'));
        const existing = db.getAccount(data.wallet);
        if (!existing) {
          db.saveAccount({
            wallet: data.wallet,
            creationTimestamp: data.creationDate ? Math.floor(new Date(data.creationDate).getTime() / 1000) : null,
            syncedFrom: data.firstTradeDate ? Math.floor(new Date(data.firstTradeDate).getTime() / 1000) : null,
            syncedTo: data.lastTradeDate ? Math.floor(new Date(data.lastTradeDate).getTime() / 1000) : null,
            syncedAt: Math.floor(Date.now() / 1000),
            tradeCountTotal: data.totalTrades,
            collateralVolume: Math.round(data.totalVolumeUsd * 1e6),
            profit: data.profitUsd ? Math.round(data.profitUsd * 1e6) : null,
            hasFullHistory: false,
          });
          result.accounts++;
        }
      } catch (e) {
        result.errors.push(`Failed to import ${file}: ${(e as Error).message}`);
      }
    }
  }

  // Import redemptions
  const redemptionsDir = join(cacheDir, 'redemptions');
  if (existsSync(redemptionsDir)) {
    for (const file of readdirSync(redemptionsDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(redemptionsDir, file), 'utf-8'));
        const redemptions: DBRedemption[] = (data.redemptions || []).map((r: JsonRedemption) => ({
          id: r.id,
          wallet: r.wallet,
          conditionId: r.conditionId,
          timestamp: Math.floor(new Date(r.timestamp).getTime() / 1000),
          payout: Math.round(r.payout * 1e6),
        }));
        result.redemptions += db.saveRedemptions(redemptions);
      } catch (e) {
        result.errors.push(`Failed to import ${file}: ${(e as Error).message}`);
      }
    }
  }

  return result;
}

function countJsonRecords(dir: string, arrayKey?: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (arrayKey) {
        count += (data[arrayKey] || []).length;
      } else {
        count++;
      }
    } catch { /* ignore */ }
  }
  return count;
}

export function validateMigration(db: TradeDB, cacheDir: string = '.cache'): ValidationResult {
  const dbCounts = {
    trades: db.getStatus().trades,
    accounts: db.getStatus().accounts,
    redemptions: db.getStatus().redemptions,
  };

  // Count trades by fills, not by file
  let jsonTradeCount = 0;
  const tradesDir = join(cacheDir, 'trades');
  if (existsSync(tradesDir)) {
    for (const file of readdirSync(tradesDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(tradesDir, file), 'utf-8'));
        for (const trade of data.trades || []) {
          jsonTradeCount += (trade.fills || []).length;
        }
      } catch { /* ignore */ }
    }
  }

  const jsonCounts = {
    trades: jsonTradeCount,
    accounts: countJsonRecords(join(cacheDir, 'accounts')),
    redemptions: countJsonRecords(join(cacheDir, 'redemptions'), 'redemptions'),
  };

  const warnings: string[] = [];
  if (dbCounts.trades > jsonCounts.trades) {
    warnings.push(`DB has more trades than JSON (deduplication or prior imports)`);
  }

  return {
    valid: dbCounts.trades === jsonCounts.trades &&
           dbCounts.accounts === jsonCounts.accounts &&
           dbCounts.redemptions === jsonCounts.redemptions,
    dbCounts,
    jsonCounts,
    warnings,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/migrate.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/migrate.ts tests/db/migrate.test.ts
git commit -m "feat(db): add JSON cache migration module"
```

---

## Task 2.2: Add Migration CLI Commands

**Files:**
- Modify: `src/index.ts`

**Step 1: Add import, validate, cleanup-cache commands**

Add to the db command group in `src/index.ts`:

```typescript
dbCommand
  .command('import')
  .description('Import data from JSON cache files')
  .option('--cache-dir <path>', 'Cache directory', '.cache')
  .action(async (opts) => {
    const { TradeDB } = await import('./db/index.js');
    const { importJsonCaches } = await import('./db/migrate.js');
    const db = new TradeDB();

    console.log(`Importing from ${opts.cacheDir}...`);
    const result = importJsonCaches(db, opts.cacheDir);

    console.log(`Imported ${result.trades} trades, ${result.accounts} accounts, ${result.redemptions} redemptions`);
    if (result.errors.length > 0) {
      console.log(`Errors: ${result.errors.length}`);
      result.errors.forEach(e => console.log(`  - ${e}`));
    }
    db.close();
  });

dbCommand
  .command('validate')
  .description('Validate migration from JSON cache')
  .option('--cache-dir <path>', 'Cache directory', '.cache')
  .action(async (opts) => {
    const { TradeDB } = await import('./db/index.js');
    const { validateMigration } = await import('./db/migrate.js');
    const db = new TradeDB();

    const result = validateMigration(db, opts.cacheDir);

    console.log(`Trades:      ${result.dbCounts.trades} DB ${result.dbCounts.trades === result.jsonCounts.trades ? '==' : '!='} ${result.jsonCounts.trades} JSON`);
    console.log(`Accounts:    ${result.dbCounts.accounts} DB ${result.dbCounts.accounts === result.jsonCounts.accounts ? '==' : '!='} ${result.jsonCounts.accounts} JSON`);
    console.log(`Redemptions: ${result.dbCounts.redemptions} DB ${result.dbCounts.redemptions === result.jsonCounts.redemptions ? '==' : '!='} ${result.jsonCounts.redemptions} JSON`);
    console.log(result.valid ? '\n✓ Validation passed' : '\n✗ Validation failed');
    result.warnings.forEach(w => console.log(`  Warning: ${w}`));
    db.close();
    process.exit(result.valid ? 0 : 1);
  });

dbCommand
  .command('cleanup-cache')
  .description('Remove JSON cache after successful migration')
  .option('--cache-dir <path>', 'Cache directory', '.cache')
  .action(async (opts) => {
    const { TradeDB } = await import('./db/index.js');
    const { validateMigration } = await import('./db/migrate.js');
    const { rmSync, existsSync } = await import('fs');
    const db = new TradeDB();

    const result = validateMigration(db, opts.cacheDir);
    if (!result.valid) {
      console.error('Validation failed - cannot cleanup. Run "db validate" for details.');
      db.close();
      process.exit(1);
    }

    if (!existsSync(opts.cacheDir)) {
      console.log('Cache directory does not exist - nothing to clean up.');
      db.close();
      return;
    }

    rmSync(opts.cacheDir, { recursive: true });
    console.log(`Removed ${opts.cacheDir}`);
    db.close();
  });
```

**Step 2: Test manually**

Run:
```bash
npm run build
./dist/index.js db import
./dist/index.js db validate
```

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): add 'db import', 'db validate', 'db cleanup-cache' commands"
```

---

# Phase 3: Integration

## Task 3.1: Create Database-Aware Account Fetcher

**Files:**
- Create: `src/api/db-accounts.ts`
- Test: `tests/api/db-accounts.test.ts`

**Step 1: Write the failing test**

Create `tests/api/db-accounts.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DBAccountFetcher } from '../../src/api/db-accounts.js';
import { TradeDB } from '../../src/db/index.js';
import { unlinkSync, existsSync } from 'fs';

describe('DBAccountFetcher', () => {
  const testDbPath = '.data/test-db-accounts.db';
  let db: TradeDB;
  let fetcher: DBAccountFetcher;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    db = new TradeDB(testDbPath);
    fetcher = new DBAccountFetcher({ db });
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
  });

  it('returns cached account when fresh', () => {
    db.saveAccount({
      wallet: '0x123',
      creationTimestamp: 1704067200,
      syncedFrom: 1704067200,
      syncedTo: Math.floor(Date.now() / 1000), // Fresh
      syncedAt: Math.floor(Date.now() / 1000),
      tradeCountTotal: 100,
      collateralVolume: 1000000000,
      profit: 50000000,
      hasFullHistory: true,
    });

    const result = fetcher.getFromDB('0x123');

    expect(result).not.toBeNull();
    expect(result!.wallet).toBe('0x123');
    expect(result!.totalTrades).toBe(100);
  });

  it('returns null when account not in DB', () => {
    expect(fetcher.getFromDB('0xnonexistent')).toBeNull();
  });

  it('detects stale accounts', () => {
    db.saveAccount({
      wallet: '0x123',
      creationTimestamp: 1704067200,
      syncedFrom: 1704067200,
      syncedTo: 1704067200, // Old timestamp
      syncedAt: 1704067200,
      tradeCountTotal: 100,
      collateralVolume: 1000000000,
      profit: 50000000,
      hasFullHistory: true,
    });

    expect(fetcher.isStale('0x123')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/db-accounts.test.ts`
Expected: FAIL

**Step 3: Implement DBAccountFetcher**

Create `src/api/db-accounts.ts`:

```typescript
import type { TradeDB } from '../db/index.js';
import type { AccountHistory } from '../signals/types.js';

export interface DBAccountFetcherOptions {
  db: TradeDB;
  staleDurationMs?: number; // Default 1 hour
}

export class DBAccountFetcher {
  private db: TradeDB;
  private staleDurationMs: number;

  constructor(options: DBAccountFetcherOptions) {
    this.db = options.db;
    this.staleDurationMs = options.staleDurationMs ?? 60 * 60 * 1000; // 1 hour
  }

  getFromDB(wallet: string): AccountHistory | null {
    const account = this.db.getAccount(wallet);
    if (!account) return null;

    return {
      wallet: account.wallet,
      totalTrades: account.tradeCountTotal ?? 0,
      firstTradeDate: account.syncedFrom ? new Date(account.syncedFrom * 1000) : null,
      lastTradeDate: account.syncedTo ? new Date(account.syncedTo * 1000) : null,
      totalVolumeUsd: account.collateralVolume ? account.collateralVolume / 1e6 : 0,
      creationDate: account.creationTimestamp ? new Date(account.creationTimestamp * 1000) : undefined,
      profitUsd: account.profit ? account.profit / 1e6 : undefined,
      dataSource: 'cache',
    };
  }

  isStale(wallet: string): boolean {
    const account = this.db.getAccount(wallet);
    if (!account || !account.syncedAt) return true;

    const syncedAtMs = account.syncedAt * 1000;
    return Date.now() - syncedAtMs > this.staleDurationMs;
  }

  saveToDBFromSubgraph(history: AccountHistory): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.saveAccount({
      wallet: history.wallet,
      creationTimestamp: history.creationDate ? Math.floor(history.creationDate.getTime() / 1000) : null,
      syncedFrom: history.firstTradeDate ? Math.floor(history.firstTradeDate.getTime() / 1000) : null,
      syncedTo: history.lastTradeDate ? Math.floor(history.lastTradeDate.getTime() / 1000) : now,
      syncedAt: now,
      tradeCountTotal: history.totalTrades,
      collateralVolume: Math.round(history.totalVolumeUsd * 1e6),
      profit: history.profitUsd ? Math.round(history.profitUsd * 1e6) : null,
      hasFullHistory: false,
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/db-accounts.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/db-accounts.ts tests/api/db-accounts.test.ts
git commit -m "feat(api): add database-aware account fetcher"
```

---

## Task 3.2: Integrate TradeDB into AccountFetcher

**Files:**
- Modify: `src/api/accounts.ts`

**Step 1: Add optional TradeDB to AccountFetcher**

Modify `src/api/accounts.ts` to accept an optional TradeDB and check it first:

Add to imports:
```typescript
import { TradeDB } from '../db/index.js';
```

Modify AccountFetcherOptions:
```typescript
export interface AccountFetcherOptions {
  subgraphClient?: SubgraphClient | null;
  cacheAccountLookup?: boolean;
  tradeDb?: TradeDB;
}
```

Add to constructor:
```typescript
  private tradeDb: TradeDB | null;

  constructor(options: AccountFetcherOptions = {}) {
    // ... existing code ...
    this.tradeDb = options.tradeDb || null;
  }
```

Modify getAccountHistory to check TradeDB first:
```typescript
  async getAccountHistory(
    wallet: string,
    options: { skipNetwork?: boolean } = {}
  ): Promise<AccountHistory | null> {
    // Check SQLite DB first (if available)
    if (this.tradeDb) {
      const account = this.tradeDb.getAccount(wallet);
      if (account && account.syncedAt) {
        const staleMs = 60 * 60 * 1000; // 1 hour
        const isFresh = Date.now() - account.syncedAt * 1000 < staleMs;
        if (isFresh) {
          return {
            wallet: account.wallet,
            totalTrades: account.tradeCountTotal ?? 0,
            firstTradeDate: account.syncedFrom ? new Date(account.syncedFrom * 1000) : null,
            lastTradeDate: account.syncedTo ? new Date(account.syncedTo * 1000) : null,
            totalVolumeUsd: account.collateralVolume ? account.collateralVolume / 1e6 : 0,
            creationDate: account.creationTimestamp ? new Date(account.creationTimestamp * 1000) : undefined,
            profitUsd: account.profit ? account.profit / 1e6 : undefined,
            dataSource: 'cache',
          };
        }
      }
    }

    // ... rest of existing code ...

    // Before returning, save to TradeDB
    if (this.tradeDb && history) {
      const now = Math.floor(Date.now() / 1000);
      this.tradeDb.saveAccount({
        wallet: history.wallet,
        creationTimestamp: history.creationDate ? Math.floor(history.creationDate.getTime() / 1000) : null,
        syncedFrom: history.firstTradeDate ? Math.floor(history.firstTradeDate.getTime() / 1000) : null,
        syncedTo: history.lastTradeDate ? Math.floor(history.lastTradeDate.getTime() / 1000) : now,
        syncedAt: now,
        tradeCountTotal: history.totalTrades,
        collateralVolume: Math.round(history.totalVolumeUsd * 1e6),
        profit: history.profitUsd ? Math.round(history.profitUsd * 1e6) : null,
        hasFullHistory: false,
      });
    }

    return history;
  }
```

**Step 2: Test**

Run: `npm run test:run`
Expected: All existing tests pass

**Step 3: Commit**

```bash
git add src/api/accounts.ts
git commit -m "feat(api): integrate TradeDB into AccountFetcher"
```

---

# Phase 4: Point-in-Time Signals

## Task 4.1: Add Historical Context to SignalContext

**Files:**
- Modify: `src/signals/types.ts`

**Step 1: Extend SignalContext**

Add to SignalContext in `src/signals/types.ts`:

```typescript
export interface SignalContext {
  config: import('../config.js').Config;
  accountHistory?: AccountHistory;
  marketPrices?: PricePoint[];
  // Point-in-time historical state (optional, from DB)
  historicalState?: {
    tradeCount: number;
    volume: number;
    pnl: number;
    approximate: boolean;
  };
}
```

**Step 2: Commit**

```bash
git add src/signals/types.ts
git commit -m "feat(signals): add historicalState to SignalContext"
```

---

## Task 4.2: Update AccountHistorySignal to Use Historical State

**Files:**
- Modify: `src/signals/accountHistory.ts`
- Modify: `tests/signals/accountHistory.test.ts`

**Step 1: Write the failing test**

Add to `tests/signals/accountHistory.test.ts`:

```typescript
  describe('point-in-time scoring', () => {
    it('uses historical trade count when available', async () => {
      const trade = makeTrade({ valueUsd: 10000 });
      const history: AccountHistory = {
        wallet: '0x123',
        totalTrades: 500, // Current count is high
        totalVolumeUsd: 100000,
        firstTradeDate: new Date('2023-01-01'),
        lastTradeDate: new Date('2024-12-01'),
        creationDate: new Date('2023-01-01'),
      };

      const context = {
        config,
        accountHistory: history,
        historicalState: {
          tradeCount: 1, // But at trade time, they only had 1 trade!
          volume: 1000,
          pnl: 0,
          approximate: false,
        },
      };

      const result = await signal.calculate(trade, context);

      // Should score based on 1 trade (historical), not 500 (current)
      expect(result.details.tradeCountScore).toBeGreaterThan(20);
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/signals/accountHistory.test.ts`
Expected: FAIL (score based on 500 trades)

**Step 3: Update AccountHistorySignal**

Modify `src/signals/accountHistory.ts` to prefer historicalState:

```typescript
  async calculate(trade: Trade, context: SignalContext): Promise<SignalResult> {
    // ... existing code ...

    // Use historical state if available, otherwise fall back to current
    const tradeCount = context.historicalState?.tradeCount ?? history.totalTrades;

    // ... use tradeCount instead of history.totalTrades for scoring ...
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/signals/accountHistory.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/signals/accountHistory.ts tests/signals/accountHistory.test.ts
git commit -m "feat(signals): use historical state in AccountHistorySignal"
```

---

## Task 4.3: Update ConvictionSignal to Use Historical State

**Files:**
- Modify: `src/signals/conviction.ts`
- Modify: `tests/signals/conviction.test.ts`

Follow similar pattern as Task 4.2 - use `historicalState.volume` instead of `accountHistory.totalVolumeUsd` when available.

**Commit:**
```bash
git add src/signals/conviction.ts tests/signals/conviction.test.ts
git commit -m "feat(signals): use historical state in ConvictionSignal"
```

---

# Phase 5: Backfill

## Task 5.1: Add Backfill Runner

**Files:**
- Create: `src/db/backfill.ts`
- Test: `tests/db/backfill.test.ts`

**Step 1: Write the failing test**

Create `tests/db/backfill.test.ts`:

```typescript
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

  it('processes queued wallets', async () => {
    db.queueBackfill('0x123', 1);
    db.queueBackfill('0x456', 2);

    const mockSubgraph = {
      getTradesByWallet: vi.fn().mockResolvedValue([]),
      getAccount: vi.fn().mockResolvedValue({ creationTimestamp: 1000 }),
    };

    await runBackfill(db, mockSubgraph as any, { maxWallets: 1 });

    // Higher priority wallet processed first
    expect(mockSubgraph.getTradesByWallet).toHaveBeenCalledWith('0x456', expect.any(Object));
    expect(db.getBackfillQueue()).toHaveLength(1); // One remaining
  });
});
```

**Step 2: Implement backfill module**

Create `src/db/backfill.ts`:

```typescript
import type { TradeDB, DBTrade } from './index.js';
import type { SubgraphClient } from '../api/subgraph.js';

export interface BackfillOptions {
  maxWallets?: number;
  maxTimeMs?: number;
}

export async function runBackfill(
  db: TradeDB,
  subgraph: SubgraphClient,
  options: BackfillOptions = {}
): Promise<number> {
  const queue = db.getBackfillQueue(options.maxWallets ?? 10);
  let processed = 0;
  const startTime = Date.now();

  for (const item of queue) {
    if (options.maxTimeMs && Date.now() - startTime > options.maxTimeMs) break;

    await backfillWallet(db, subgraph, item.wallet);
    processed++;
  }

  return processed;
}

export async function backfillWallet(
  db: TradeDB,
  subgraph: SubgraphClient,
  wallet: string
): Promise<void> {
  db.markBackfillStarted(wallet);

  try {
    const account = db.getAccount(wallet);
    let cursor = account?.syncedFrom ?? undefined;

    while (true) {
      const trades = await subgraph.getTradesByWallet(wallet, {
        before: cursor ? new Date(cursor * 1000) : undefined,
        limit: 1000,
      });

      if (trades.length === 0) break;

      const dbTrades: DBTrade[] = trades.flatMap(t =>
        t.fills.map(f => ({
          id: f.id,
          txHash: t.transactionHash,
          wallet: t.wallet,
          marketId: t.marketId,
          timestamp: Math.floor(new Date(f.timestamp).getTime() / 1000),
          side: t.side,
          action: t.action,
          role: t.role,
          size: Math.round(f.size * 1e6),
          price: Math.round(f.price * 1e6),
          valueUsd: Math.round(f.valueUsd * 1e6),
        }))
      );

      db.saveTrades(dbTrades);
      cursor = Math.min(...trades.map(t => Math.floor(t.timestamp.getTime() / 1000)));
    }

    db.markComplete(wallet);
    db.markBackfillComplete(wallet);
  } catch (e) {
    // Don't mark complete on error - will retry next time
    console.error(`Backfill failed for ${wallet}: ${(e as Error).message}`);
  }
}
```

**Step 3: Run test to verify it passes**

Run: `npx vitest run tests/db/backfill.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/db/backfill.ts tests/db/backfill.test.ts
git commit -m "feat(db): add backfill runner"
```

---

## Task 5.2: Add `db backfill` CLI Command

**Files:**
- Modify: `src/index.ts`

Add to db command group:

```typescript
dbCommand
  .command('backfill [wallet]')
  .description('Backfill trade history for queued wallets or a specific wallet')
  .option('--max <n>', 'Maximum wallets to process', parseInt)
  .action(async (wallet: string | undefined, opts) => {
    const { TradeDB } = await import('./db/index.js');
    const { SubgraphClient } = await import('./api/subgraph.js');
    const { runBackfill, backfillWallet } = await import('./db/backfill.js');

    const db = new TradeDB();
    const subgraph = new SubgraphClient();

    if (wallet) {
      console.log(`Backfilling ${wallet}...`);
      await backfillWallet(db, subgraph, wallet);
      console.log('Done');
    } else {
      const queueSize = db.getBackfillQueue().length;
      console.log(`Processing ${Math.min(opts.max ?? 10, queueSize)} of ${queueSize} queued wallets...`);
      const processed = await runBackfill(db, subgraph, { maxWallets: opts.max });
      console.log(`Processed ${processed} wallets`);
    }

    db.close();
  });
```

**Commit:**
```bash
git add src/index.ts
git commit -m "feat(cli): add 'db backfill' command"
```

---

## Task 5.3: Integrate Backfill Triggers

**Files:**
- Modify: `src/commands/analyze.ts`
- Modify: `src/commands/investigate.ts`
- Modify: `src/commands/monitor.ts`

Add backfill triggering after each command's main logic. For investigate, do blocking backfill before analysis.

**Commit:**
```bash
git add src/commands/*.ts
git commit -m "feat(commands): integrate backfill triggers"
```

---

# Phase 6: Cleanup

## Task 6.1: Remove Old Cache Classes

**Files:**
- Delete: `src/api/account-cache.ts`
- Delete: `src/api/cache.ts`
- Delete: `src/api/redemption-cache.ts`
- Delete: `src/api/trade-count-cache.ts`
- Delete corresponding test files
- Modify: `src/api/accounts.ts` to remove old cache imports

**Step 1: Remove imports and usages**

Update `src/api/accounts.ts` to remove all references to the old cache classes.

**Step 2: Delete files**

```bash
rm src/api/account-cache.ts
rm src/api/cache.ts
rm src/api/redemption-cache.ts
rm src/api/trade-count-cache.ts
rm tests/api/account-cache.test.ts
rm tests/api/redemption-cache.test.ts
rm tests/api/trade-count-cache.test.ts
```

**Step 3: Run tests**

Run: `npm run test:run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove old JSON cache classes"
```

---

## Task 6.2: Update .gitignore

**Files:**
- Modify: `.gitignore`

Add:
```
# SQLite database
.data/
```

**Commit:**
```bash
git add .gitignore
git commit -m "chore: add .data/ to gitignore"
```

---

## Task 6.3: Update PROJECT_STATUS.md

**Files:**
- Modify: `PROJECT_STATUS.md`

Update to reflect:
- SQLite database replaces JSON caching
- New `db` CLI commands
- Point-in-time account state queries
- Background backfill system

**Commit:**
```bash
git add PROJECT_STATUS.md
git commit -m "docs: update PROJECT_STATUS.md for database implementation"
```

---

# Final Checkpoint

Run full verification:

```bash
npm run test:run  # All tests pass
npm run build     # No TypeScript errors
./dist/index.js db status  # Database operational
```

Merge to main when ready:

```bash
git checkout main
git merge trade-database
git push
```
