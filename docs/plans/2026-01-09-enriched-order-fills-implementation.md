# Enriched Order Fills Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `trades` table with `enriched_order_fills` to store raw subgraph data (1 fill = 1 row), removing derived fields and fixing the double-row bug.

**Architecture:** The new `enriched_order_fills` table mirrors the subgraph's `EnrichedOrderFilled` entity. Role-based queries use `maker`/`taker` columns directly. Application layer (`aggregateFills`) handles deriving wallet action from maker's side.

**Tech Stack:** better-sqlite3, TypeScript, Vitest

---

## Task 1: Update Database Schema

**Files:**
- Modify: `src/db/schema.ts`

**Step 1: Update schema.ts with new table**

Replace the `trades` table definition with `enriched_order_fills`:

```typescript
// In src/db/schema.ts, replace:
// -- Core trade data (one row per fill)
// CREATE TABLE IF NOT EXISTS trades (
//   id TEXT PRIMARY KEY,
//   ...
// );

// With:
    -- Raw subgraph fills (one row per EnrichedOrderFilled)
    CREATE TABLE IF NOT EXISTS enriched_order_fills (
      id TEXT PRIMARY KEY,
      transaction_hash TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      order_hash TEXT NOT NULL,
      side TEXT NOT NULL,
      size INTEGER NOT NULL,
      price INTEGER NOT NULL,
      maker TEXT NOT NULL,
      taker TEXT NOT NULL,
      market TEXT NOT NULL
    );
```

Also update the indexes:

```typescript
// Replace:
// CREATE INDEX IF NOT EXISTS idx_trades_wallet_time ON trades(wallet, timestamp);
// CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id, timestamp);

// With:
    CREATE INDEX IF NOT EXISTS idx_fills_maker_time ON enriched_order_fills(maker, timestamp);
    CREATE INDEX IF NOT EXISTS idx_fills_taker_time ON enriched_order_fills(taker, timestamp);
    CREATE INDEX IF NOT EXISTS idx_fills_market ON enriched_order_fills(market, timestamp);
    CREATE INDEX IF NOT EXISTS idx_fills_tx ON enriched_order_fills(transaction_hash);
```

Bump schema version to 3.

**Step 2: Verify build compiles**

Run: `npm run build`
Expected: Build fails (type errors in index.ts referencing old schema)

---

## Task 2: Update TradeDB Types

**Files:**
- Modify: `src/db/index.ts`

**Step 1: Replace DBTrade with DBEnrichedOrderFill**

Replace the `DBTrade` interface:

```typescript
// Remove:
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

// Add:
export interface DBEnrichedOrderFill {
  id: string;
  transactionHash: string;
  timestamp: number;
  orderHash: string;
  side: 'Buy' | 'Sell';
  size: number;      // 6 decimals
  price: number;     // 6 decimals
  maker: string;
  taker: string;
  market: string;
}
```

**Step 2: Update DBStatus interface**

```typescript
export interface DBStatus {
  path: string;
  fills: number;      // renamed from 'trades'
  accounts: number;
  redemptions: number;
  markets: number;
  backfillQueue: number;
}
```

**Step 3: Update GetTradesForMarketOptions**

```typescript
// Rename to GetFillsOptions
export interface GetFillsOptions {
  after?: number;
  before?: number;
  role?: 'maker' | 'taker' | 'both';
  limit?: number;
}
```

---

## Task 3: Update TradeDB Methods

**Files:**
- Modify: `src/db/index.ts`

**Step 1: Update getStatus()**

```typescript
getStatus(): DBStatus {
  const count = (table: string): number => {
    const result = this.db
      .prepare(`SELECT COUNT(*) as n FROM ${table}`)
      .get() as { n: number };
    return result.n;
  };

  return {
    path: this.dbPath,
    fills: count('enriched_order_fills'),
    accounts: count('accounts'),
    redemptions: count('redemptions'),
    markets: count('markets'),
    backfillQueue: count('backfill_queue'),
  };
}
```

**Step 2: Replace saveTrades with saveFills**

```typescript
saveFills(fills: DBEnrichedOrderFill[]): number {
  const stmt = this.db.prepare(`
    INSERT OR IGNORE INTO enriched_order_fills
    (id, transaction_hash, timestamp, order_hash, side, size, price, maker, taker, market)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;

  const insertMany = this.db.transaction((fills: DBEnrichedOrderFill[]) => {
    for (const f of fills) {
      const result = stmt.run(
        f.id,
        f.transactionHash,
        f.timestamp,
        f.orderHash,
        f.side,
        f.size,
        f.price,
        f.maker.toLowerCase(),
        f.taker.toLowerCase(),
        f.market
      );
      inserted += result.changes;
    }
  });

  insertMany(fills);
  return inserted;
}
```

**Step 3: Replace getTradesForWallet with getFillsForWallet**

```typescript
getFillsForWallet(
  wallet: string,
  options: GetFillsOptions = {}
): DBEnrichedOrderFill[] {
  const walletLower = wallet.toLowerCase();
  const role = options.role ?? 'both';

  let sql: string;
  let params: (string | number)[] = [];

  if (role === 'maker') {
    sql = `SELECT * FROM enriched_order_fills WHERE maker = ?`;
    params = [walletLower];
  } else if (role === 'taker') {
    sql = `SELECT * FROM enriched_order_fills WHERE taker = ?`;
    params = [walletLower];
  } else {
    // 'both' - wallet is either maker or taker
    sql = `SELECT * FROM enriched_order_fills WHERE maker = ? OR taker = ?`;
    params = [walletLower, walletLower];
  }

  if (options.after !== undefined) {
    sql += ' AND timestamp >= ?';
    params.push(options.after);
  }
  if (options.before !== undefined) {
    sql += ' AND timestamp <= ?';
    params.push(options.before);
  }

  sql += ' ORDER BY timestamp DESC';

  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = this.db.prepare(sql).all(...params) as {
    id: string;
    transaction_hash: string;
    timestamp: number;
    order_hash: string;
    side: string;
    size: number;
    price: number;
    maker: string;
    taker: string;
    market: string;
  }[];

  return rows.map(r => ({
    id: r.id,
    transactionHash: r.transaction_hash,
    timestamp: r.timestamp,
    orderHash: r.order_hash,
    side: r.side as 'Buy' | 'Sell',
    size: r.size,
    price: r.price,
    maker: r.maker,
    taker: r.taker,
    market: r.market,
  }));
}
```

**Step 4: Replace getTradesForMarket with getFillsForMarket**

```typescript
getFillsForMarket(
  market: string,
  options: GetFillsOptions = {}
): DBEnrichedOrderFill[] {
  let sql = `SELECT * FROM enriched_order_fills WHERE market = ?`;
  const params: (string | number)[] = [market];

  if (options.after !== undefined) {
    sql += ' AND timestamp >= ?';
    params.push(options.after);
  }
  if (options.before !== undefined) {
    sql += ' AND timestamp <= ?';
    params.push(options.before);
  }

  // Role filter: for market queries, filter by which side we want to analyze
  if (options.role === 'maker') {
    // No additional filter needed - all fills have makers
    // This is for when we want to analyze maker behavior
  } else if (options.role === 'taker') {
    // No additional filter needed - all fills have takers
    // This is for when we want to analyze taker behavior
  }
  // 'both' or undefined: return all fills

  sql += ' ORDER BY timestamp DESC';

  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = this.db.prepare(sql).all(...params) as {
    id: string;
    transaction_hash: string;
    timestamp: number;
    order_hash: string;
    side: string;
    size: number;
    price: number;
    maker: string;
    taker: string;
    market: string;
  }[];

  return rows.map(r => ({
    id: r.id,
    transactionHash: r.transaction_hash,
    timestamp: r.timestamp,
    orderHash: r.order_hash,
    side: r.side as 'Buy' | 'Sell',
    size: r.size,
    price: r.price,
    maker: r.maker,
    taker: r.taker,
    market: r.market,
  }));
}
```

**Step 5: Update getAccountStateAt**

This method needs rethinking since we no longer have `action` or `value_usd` columns. For now, mark it as needing the application layer to compute these values:

```typescript
getAccountStateAt(wallet: string, atTimestamp: number): PointInTimeState {
  const account = this.getAccount(wallet);
  const approximate = !account || !account.hasFullHistory ||
    (account.syncedFrom !== null && account.syncedFrom > atTimestamp);

  const walletLower = wallet.toLowerCase();

  // Count fills where wallet participated (as maker or taker)
  const result = this.db.prepare(`
    SELECT COUNT(*) as tradeCount,
           COALESCE(SUM(size), 0) as volume
    FROM enriched_order_fills
    WHERE (maker = ? OR taker = ?) AND timestamp < ?
  `).get(walletLower, walletLower, atTimestamp) as { tradeCount: number; volume: number };

  // P&L calculation needs to be done in application layer now
  // since we need to know token outcome (YES/NO) to determine profit
  return {
    tradeCount: result.tradeCount,
    volume: result.volume,
    pnl: 0, // TODO: Requires market resolution data to compute
    approximate,
  };
}
```

**Step 6: Remove old methods**

Delete `saveTrades`, `getTradesForWallet`, `getTradesForMarket` methods.

---

## Task 4: Update Schema Tests

**Files:**
- Modify: `tests/db/schema.test.ts`

**Step 1: Update table name assertions**

```typescript
it('creates all required tables', () => {
  initializeSchema(db);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];

  const tableNames = tables.map(t => t.name);

  expect(tableNames).toContain('enriched_order_fills');  // Changed from 'trades'
  expect(tableNames).toContain('accounts');
  expect(tableNames).toContain('redemptions');
  expect(tableNames).toContain('markets');
  expect(tableNames).toContain('backfill_queue');
  expect(tableNames).toContain('schema_version');
});
```

**Step 2: Update index assertions**

```typescript
it('creates required indexes', () => {
  initializeSchema(db);

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];

  const indexNames = indexes.map(i => i.name);

  expect(indexNames).toContain('idx_fills_maker_time');
  expect(indexNames).toContain('idx_fills_taker_time');
  expect(indexNames).toContain('idx_fills_market');
  expect(indexNames).toContain('idx_fills_tx');
  expect(indexNames).toContain('idx_redemptions_wallet');
});
```

**Step 3: Run tests**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: Tests pass (may need to remove migration test that references old schema)

---

## Task 5: Update TradeDB Tests

**Files:**
- Modify: `tests/db/index.test.ts`

**Step 1: Update status test**

```typescript
describe('status', () => {
  it('returns database statistics', () => {
    const status = tradeDb.getStatus();

    expect(status).toEqual({
      path: testDbPath,
      fills: 0,           // Changed from 'trades'
      accounts: 0,
      redemptions: 0,
      markets: 0,
      backfillQueue: 0,
    });
  });
});
```

**Step 2: Replace trades tests with fills tests**

```typescript
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
    expect(fills).toHaveLength(2); // fill-1 (maker) and fill-3 (taker)
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
```

**Step 3: Update or remove point-in-time tests**

The point-in-time tests need updating since P&L calculation changes. For now, simplify to just test trade count and volume:

```typescript
describe('point-in-time queries', () => {
  beforeEach(() => {
    tradeDb.saveFills([
      { id: 'fill-1', transactionHash: '0xa', timestamp: 1000, orderHash: '0xo1',
        side: 'Buy', size: 50000000, price: 500000, maker: '0xOther', taker: '0x123', market: 't1' },
      { id: 'fill-2', transactionHash: '0xb', timestamp: 2000, orderHash: '0xo2',
        side: 'Sell', size: 60000000, price: 600000, maker: '0x123', taker: '0xOther', market: 't1' },
      { id: 'fill-3', transactionHash: '0xc', timestamp: 3000, orderHash: '0xo3',
        side: 'Buy', size: 80000000, price: 400000, maker: '0xOther', taker: '0x123', market: 't2' },
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

  it('marks as approximate when data is incomplete', () => {
    tradeDb.saveAccount({
      wallet: '0x456', creationTimestamp: 500, syncedFrom: 2000, syncedTo: 3000,
      syncedAt: Date.now(), tradeCountTotal: 10, collateralVolume: 100000000,
      profit: 0, hasFullHistory: false,
    });
    expect(tradeDb.getAccountStateAt('0x456', 1500).approximate).toBe(true);
  });
});
```

**Step 4: Run tests**

Run: `npx vitest run tests/db/index.test.ts`
Expected: Tests pass

---

## Task 6: Update Integration Tests

**Files:**
- Modify: `tests/db/integration.test.ts`

**Step 1: Rewrite trade saving tests**

Replace the double-perspective tests with single-fill tests:

```typescript
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

    // Alice is maker in fill-1
    const aliceMaker = db.getFillsForWallet('0xalice', { role: 'maker' });
    expect(aliceMaker).toHaveLength(1);

    // Bob is taker in fill-1, maker in fill-2
    const bobBoth = db.getFillsForWallet('0xbob', { role: 'both' });
    expect(bobBoth).toHaveLength(2);

    const bobTaker = db.getFillsForWallet('0xbob', { role: 'taker' });
    expect(bobTaker).toHaveLength(1);
  });
});
```

**Step 2: Update point-in-time tests**

Simplify to match the new schema (no P&L calculation in DB):

```typescript
describe('point-in-time queries with saved fills', () => {
  beforeEach(() => {
    db.saveAccount({
      wallet: '0xtrader',
      creationTimestamp: 500,
      syncedFrom: 1000,
      syncedTo: 5000,
      syncedAt: Math.floor(Date.now() / 1000),
      tradeCountTotal: 3,
      collateralVolume: 190000000,
      profit: 0,
      hasFullHistory: true,
    });

    db.saveFills([
      {
        id: 'fill-1',
        transactionHash: '0xa',
        timestamp: 1000,
        orderHash: '0xo1',
        side: 'Buy',
        size: 50000000,
        price: 500000,
        maker: '0xother',
        taker: '0xtrader',
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
        maker: '0xtrader',
        taker: '0xother',
        market: 'token-1',
      },
      {
        id: 'fill-3',
        transactionHash: '0xc',
        timestamp: 3000,
        orderHash: '0xo3',
        side: 'Buy',
        size: 80000000,
        price: 400000,
        maker: '0xother',
        taker: '0xtrader',
        market: 'token-2',
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

  it('marks as not approximate when full history available', () => {
    expect(db.getAccountStateAt('0xtrader', 2500).approximate).toBe(false);
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run tests/db/integration.test.ts`
Expected: Tests pass

---

## Task 7: Update Analyze Command

**Files:**
- Modify: `src/commands/analyze.ts`

**Step 1: Update imports**

```typescript
// Change:
import { TradeDB, type DBTrade } from '../db/index.js';

// To:
import { TradeDB, type DBEnrichedOrderFill } from '../db/index.js';
```

**Step 2: Rewrite saveTradesFromFills method**

This is the key fix - save one row per fill instead of two:

```typescript
/**
 * Save SubgraphTrade fills to DB (one row per fill)
 */
private saveTradesFromFills(fills: SubgraphTrade[]): number {
  const dbFills: DBEnrichedOrderFill[] = fills.map(fill => ({
    id: fill.id,
    transactionHash: fill.transactionHash,
    timestamp: fill.timestamp,
    orderHash: fill.orderHash ?? fill.id, // Use id as fallback if orderHash missing
    side: fill.side,
    size: parseInt(fill.size),
    price: Math.round(parseFloat(fill.price) * 1e6),
    maker: fill.maker.toLowerCase(),
    taker: fill.taker.toLowerCase(),
    market: fill.marketId,
  }));

  return this.tradeDb.saveFills(dbFills);
}
```

**Step 3: Rewrite convertDBTradesToSubgraph method**

Rename and simplify (no more suffix stripping):

```typescript
/**
 * Convert DBEnrichedOrderFill records back to SubgraphTrade format for aggregation
 */
private convertDBFillsToSubgraph(dbFills: DBEnrichedOrderFill[]): SubgraphTrade[] {
  return dbFills.map(f => ({
    id: f.id,
    transactionHash: f.transactionHash,
    timestamp: f.timestamp,
    orderHash: f.orderHash,
    maker: f.maker,
    taker: f.taker,
    marketId: f.market,
    side: f.side,
    size: f.size.toString(),
    price: (f.price / 1e6).toString(), // Convert back to decimal string
  }));
}
```

**Step 4: Update fetchRawFillsWithCache method**

Update the calls to use new method names:

```typescript
// Change:
const dbTrades = this.tradeDb.getTradesForMarket(token.tokenId, {
  after: requestedRange.after,
  before: requestedRange.before,
  limit: perTokenLimit,
});
const fills = this.convertDBTradesToSubgraph(dbTrades, token.tokenId);

// To:
const dbFills = this.tradeDb.getFillsForMarket(token.tokenId, {
  after: requestedRange.after,
  before: requestedRange.before,
  limit: perTokenLimit,
});
const fills = this.convertDBFillsToSubgraph(dbFills);
```

Also update the cached count logging:

```typescript
// Change:
const cachedCount = this.tradeDb.getTradesForMarket(token.tokenId, { role: 'taker' }).length;

// To:
const cachedCount = this.tradeDb.getFillsForMarket(token.tokenId).length;
```

**Step 5: Build and verify**

Run: `npm run build`
Expected: Build succeeds

---

## Task 8: Update Backfill Module

**Files:**
- Modify: `src/db/backfill.ts`

**Step 1: Update imports**

```typescript
// Change:
import type { TradeDB, DBTrade, DBAccount } from './index.js';

// To:
import type { TradeDB, DBEnrichedOrderFill, DBAccount } from './index.js';
```

**Step 2: Rewrite convertTradesToDBFormat function**

```typescript
/**
 * Convert SubgraphTrade[] to DBEnrichedOrderFill[] format
 */
function convertTradesToDBFormat(trades: SubgraphTrade[]): DBEnrichedOrderFill[] {
  return trades.map(trade => ({
    id: trade.id,
    transactionHash: trade.transactionHash,
    timestamp: trade.timestamp,
    orderHash: trade.orderHash ?? trade.id,
    side: trade.side,
    size: parseInt(trade.size),
    price: Math.round(parseFloat(trade.price) * 1e6),
    maker: trade.maker.toLowerCase(),
    taker: trade.taker.toLowerCase(),
    market: trade.marketId,
  }));
}
```

**Step 3: Update backfillWallet to use saveFills**

```typescript
// Change:
const dbTrades = convertTradesToDBFormat(trades, normalizedWallet);
db.saveTrades(dbTrades);

// To:
const dbFills = convertTradesToDBFormat(trades);
db.saveFills(dbFills);
```

**Step 4: Run tests**

Run: `npx vitest run tests/db/backfill.test.ts`
Expected: Tests pass (may need updates to mock data)

---

## Task 9: Update Backfill Tests

**Files:**
- Modify: `tests/db/backfill.test.ts`

**Step 1: Update mock subgraph trades**

Ensure mock trades have the `orderHash` field:

```typescript
const mockSubgraph = {
  getTradesByWallet: vi.fn().mockResolvedValue([
    {
      id: 'fill-1',
      transactionHash: '0xabc',
      timestamp: 1000,
      orderHash: '0xorder1',
      side: 'Buy',
      size: '50000000',
      price: '0.5',
      maker: '0xother',
      taker: '0x123',
      marketId: 'token-1',
    },
  ]),
  getAccount: vi.fn().mockResolvedValue({ creationTimestamp: 500 }),
};
```

**Step 2: Run tests**

Run: `npx vitest run tests/db/backfill.test.ts`
Expected: Tests pass

---

## Task 10: Update Remaining Files

**Files:**
- Modify: `src/api/trade-cache.ts` (if it references DBTrade)
- Modify: `src/db/migrate.ts` (if it references old schema)
- Modify: `src/index.ts` (CLI status command)

**Step 1: Update CLI db status command**

In `src/index.ts`, update the status output:

```typescript
// Change:
console.log(`Trades: ${status.trades.toLocaleString()}`);

// To:
console.log(`Fills: ${status.fills.toLocaleString()}`);
```

**Step 2: Update trade-cache.ts if needed**

Check if `TradeCacheChecker` uses the old method names and update.

**Step 3: Update migrate.ts**

The migration module imports from JSON cache files. It may need updates if the JSON format differs, but since we're reimporting from `.cache` files anyway, this can be done as a separate pass.

---

## Task 11: Run Full Test Suite

**Step 1: Run all tests**

Run: `npm run test:run`
Expected: All tests pass

**Step 2: Build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 3: Manual verification**

Run: `./dist/index.js db status`
Expected: Shows `Fills: 0` (empty database)

---

## Task 12: Delete Database and Reimport

**Step 1: Delete old database**

```bash
rm -f .data/trades.db .data/trades.db-wal .data/trades.db-shm
```

**Step 2: Reimport from cache**

```bash
./dist/index.js db import
```

Expected: Imports data from `.cache` directory (if migration module is updated)

**Step 3: Verify**

```bash
./dist/index.js db status
```

Expected: Shows fills count > 0

---

## Task 13: Commit

**Step 1: Stage changes**

```bash
git add -A
```

**Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(db): replace trades table with enriched_order_fills

- Store raw subgraph EnrichedOrderFilled data (1 fill = 1 row)
- Remove derived fields: wallet, action, role, value_usd
- Add maker/taker columns for role-based queries
- Fix bug where one fill was stored as two rows (-maker/-taker suffixes)
- Update TradeDB methods: saveFills, getFillsForWallet, getFillsForMarket
- Update analyze.ts and backfill.ts to use new schema

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Final Checkpoint

Run full verification:

```bash
npm run test:run  # All tests pass
npm run build     # No TypeScript errors
./dist/index.js db status  # Database operational
```
