# Market Impact Signal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable TradeSizeSignal to calculate actual market impact by fetching price history from the CLOB API and caching it in SQLite.

**Architecture:** DB-first caching strategy. PriceFetcher checks DB cache coverage, fetches missing ranges from CLOB API, stores in SQLite. SignalContext passes per-token prices as a Map. Commands fetch prices before scoring.

**Tech Stack:** TypeScript, better-sqlite3, CLOB API (`/prices-history`), Vitest

---

## Task 1: Add Price History DB Schema

**Files:**
- Modify: `src/db/schema.ts:10-82`

**Step 1: Write the migration test**

Create file `tests/db/price-history.test.ts`:

```typescript
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
    // Table should exist after initialization
    const status = db.getStatus();
    expect(status).toHaveProperty('priceHistory');
    expect(status.priceHistory).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/price-history.test.ts -v`
Expected: FAIL with "priceHistory" property not found

**Step 3: Add schema to src/db/schema.ts**

Add after line 74 (before indexes):

```typescript
    -- Price history for market impact calculation
    CREATE TABLE IF NOT EXISTS price_history (
      token_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      price INTEGER NOT NULL,
      PRIMARY KEY (token_id, timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_prices_token_time ON price_history(token_id, timestamp);
```

**Step 4: Update getStatus() in src/db/index.ts**

Add to `DBStatus` interface (after line 14):

```typescript
  priceHistory: number;
```

Add to `getStatus()` return object (after line 121):

```typescript
      priceHistory: count('price_history'),
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db/price-history.test.ts -v`
Expected: PASS

**Step 6: Commit**

```bash
git add src/db/schema.ts src/db/index.ts tests/db/price-history.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add price_history table schema

Add SQLite table for caching CLOB price history data with
token_id + timestamp composite primary key.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add Price DB Methods

**Files:**
- Modify: `src/db/index.ts`
- Modify: `tests/db/price-history.test.ts`

**Step 1: Add interface and write failing tests**

Add to `tests/db/price-history.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db/price-history.test.ts -v`
Expected: FAIL with "savePrices is not a function"

**Step 3: Add interfaces to src/db/index.ts**

Add after `BackfillQueueItem` interface (around line 87):

```typescript
export interface DBPricePoint {
  timestamp: number;
  price: number;  // 0-1 decimal
}

export interface PriceSyncStatus {
  syncedFrom?: number;
  syncedTo?: number;
}
```

**Step 4: Add savePrices method**

Add to `TradeDB` class (before `close()` method):

```typescript
  savePrices(tokenId: string, prices: DBPricePoint[]): number {
    if (prices.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO price_history (token_id, timestamp, price)
      VALUES (?, ?, ?)
    `);

    let inserted = 0;

    const insertMany = this.db.transaction((prices: DBPricePoint[]) => {
      for (const p of prices) {
        // Store price as 6-decimal scaled integer
        const result = stmt.run(tokenId, p.timestamp, Math.round(p.price * 1e6));
        inserted += result.changes;
      }
    });

    insertMany(prices);
    return inserted;
  }
```

**Step 5: Add getPricesForToken method**

```typescript
  getPricesForToken(tokenId: string, startTs: number, endTs: number): DBPricePoint[] {
    const rows = this.db.prepare(`
      SELECT timestamp, price FROM price_history
      WHERE token_id = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(tokenId, startTs, endTs) as { timestamp: number; price: number }[];

    return rows.map(r => ({
      timestamp: r.timestamp,
      price: r.price / 1e6,  // Convert back to 0-1 decimal
    }));
  }
```

**Step 6: Add getPriceSyncStatus method**

```typescript
  getPriceSyncStatus(tokenId: string): PriceSyncStatus {
    const row = this.db.prepare(`
      SELECT MIN(timestamp) as syncedFrom, MAX(timestamp) as syncedTo
      FROM price_history WHERE token_id = ?
    `).get(tokenId) as { syncedFrom: number | null; syncedTo: number | null } | undefined;

    return {
      syncedFrom: row?.syncedFrom ?? undefined,
      syncedTo: row?.syncedTo ?? undefined,
    };
  }
```

**Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/db/price-history.test.ts -v`
Expected: PASS

**Step 8: Commit**

```bash
git add src/db/index.ts tests/db/price-history.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add price history CRUD methods

- savePrices(): bulk insert with idempotency
- getPricesForToken(): range query by timestamp
- getPriceSyncStatus(): get cached time bounds

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create PriceFetcher Module

**Files:**
- Create: `src/api/prices.ts`
- Create: `tests/api/price-fetcher.test.ts`

**Step 1: Write the unit test (mocked)**

Create `tests/api/price-fetcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PriceFetcher } from '../../src/api/prices.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('PriceFetcher', () => {
  let fetcher: PriceFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new PriceFetcher();
  });

  describe('fetchFromApi', () => {
    it('fetches prices from CLOB API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          history: [
            { t: 1000, p: 0.5 },
            { t: 1060, p: 0.52 },
          ],
        }),
      });

      const prices = await fetcher.fetchFromApi('token-123', 900, 1100);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('clob.polymarket.com/prices-history')
      );
      expect(prices).toHaveLength(2);
      expect(prices[0]).toEqual({ timestamp: 1000, price: 0.5 });
    });

    it('returns empty array on API error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const prices = await fetcher.fetchFromApi('token-123', 900, 1100);
      expect(prices).toEqual([]);
    });
  });

  describe('getPricesForToken', () => {
    it('fetches from API when no DB provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ history: [{ t: 1000, p: 0.5 }] }),
      });

      const prices = await fetcher.getPricesForToken('token-123', 900, 1100);
      expect(prices).toHaveLength(1);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/price-fetcher.test.ts -v`
Expected: FAIL with "Cannot find module"

**Step 3: Create src/api/prices.ts**

```typescript
import type { TradeDB, DBPricePoint } from '../db/index.js';

const CLOB_ENDPOINT = 'https://clob.polymarket.com';

interface CLOBPricePoint {
  t: number;  // Unix timestamp
  p: number;  // Price (0-1)
}

interface CLOBPriceResponse {
  history: CLOBPricePoint[];
}

export class PriceFetcher {
  constructor(private db?: TradeDB) {}

  /**
   * Fetch prices directly from CLOB API.
   * Returns empty array on error (graceful degradation).
   */
  async fetchFromApi(
    tokenId: string,
    startTs: number,
    endTs: number
  ): Promise<DBPricePoint[]> {
    try {
      const url = new URL(`${CLOB_ENDPOINT}/prices-history`);
      url.searchParams.set('market', tokenId);
      url.searchParams.set('startTs', startTs.toString());
      url.searchParams.set('endTs', endTs.toString());

      const response = await fetch(url.toString());
      if (!response.ok) {
        console.warn(`Price API error: HTTP ${response.status}`);
        return [];
      }

      const data: CLOBPriceResponse = await response.json();
      return data.history.map(p => ({
        timestamp: p.t,
        price: p.p,
      }));
    } catch (error) {
      console.warn(`Price API error: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Get prices for a token, using DB cache when available.
   * Fetches missing ranges from API and saves to DB.
   */
  async getPricesForToken(
    tokenId: string,
    startTs: number,
    endTs: number
  ): Promise<DBPricePoint[]> {
    if (!this.db) {
      return this.fetchFromApi(tokenId, startTs, endTs);
    }

    // Check cache coverage
    const sync = this.db.getPriceSyncStatus(tokenId);
    const hasCoverage = sync.syncedFrom !== undefined &&
      sync.syncedTo !== undefined &&
      sync.syncedFrom <= startTs &&
      sync.syncedTo >= endTs;

    if (hasCoverage) {
      return this.db.getPricesForToken(tokenId, startTs, endTs);
    }

    // Fetch from API and cache
    const prices = await this.fetchFromApi(tokenId, startTs, endTs);
    if (prices.length > 0) {
      this.db.savePrices(tokenId, prices);
    }

    return prices;
  }

  /**
   * Batch fetch prices for multiple tokens.
   * Returns Map of tokenId -> prices.
   */
  async getPricesForMarket(
    tokenIds: string[],
    startTs: number,
    endTs: number
  ): Promise<Map<string, DBPricePoint[]>> {
    const result = new Map<string, DBPricePoint[]>();

    // Fetch in parallel
    const promises = tokenIds.map(async tokenId => {
      const prices = await this.getPricesForToken(tokenId, startTs, endTs);
      result.set(tokenId, prices);
    });

    await Promise.all(promises);
    return result;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/price-fetcher.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/prices.ts tests/api/price-fetcher.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add PriceFetcher with DB caching

- fetchFromApi(): direct CLOB API call
- getPricesForToken(): DB-first with fallback to API
- getPricesForMarket(): batch fetch for multiple tokens

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update SignalContext Type

**Files:**
- Modify: `src/signals/types.ts:22-26`

**Step 1: Write failing test for Map type**

Add to `tests/signals/tradeSize.test.ts` (create if not extensive):

```typescript
import { describe, it, expect } from 'vitest';
import { TradeSizeSignal } from '../../src/signals/tradeSize.js';
import type { SignalContext, PricePoint } from '../../src/signals/types.js';
import type { AggregatedTrade } from '../../src/api/types.js';

describe('TradeSizeSignal with Map-based prices', () => {
  const signal = new TradeSizeSignal();

  const mockTrade: AggregatedTrade = {
    transactionHash: '0xabc',
    wallet: '0x123',
    marketId: 'token-456',
    outcome: 'YES',
    side: 'BUY',
    avgPrice: 0.5,
    totalSize: 1000,
    totalValueUsd: 5000,
    timestamp: new Date(1000000 * 1000),
    fillCount: 1,
    fills: [],
  };

  it('calculates impact from per-token price Map', async () => {
    const pricesMap = new Map<string, PricePoint[]>();
    pricesMap.set('token-456', [
      { timestamp: new Date(999700 * 1000), price: 0.4 },
      { timestamp: new Date(1000300 * 1000), price: 0.5 },
    ]);

    const context: SignalContext = {
      config: {
        tradeSize: { minAbsoluteUsd: 1000, minImpactPercent: 5, impactWindowMinutes: 5 },
        accountHistory: { maxAgeDays: 30, maxTradeCount: 50, dormancyDays: 90 },
        conviction: { highConvictionThreshold: 0.85 },
        alertThreshold: 70,
        filters: { excludeSafeBets: true, safeBetThreshold: 0.9 },
        subgraph: { enabled: true, timeout: 30000, retries: 3 },
      },
      marketPrices: pricesMap,
    };

    const result = await signal.calculate(mockTrade, context);
    expect(result.details).toHaveProperty('impactPercent');
    expect((result.details as any).impactPercent).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/signals/tradeSize.test.ts -v`
Expected: FAIL with type error (marketPrices expects PricePoint[] not Map)

**Step 3: Update SignalContext in src/signals/types.ts**

Change line 25 from:

```typescript
  marketPrices?: PricePoint[];
```

To:

```typescript
  marketPrices?: Map<string, PricePoint[]>;  // tokenId -> prices
```

**Step 4: Run test again - still fails**

Expected: impactPercent is 0 because TradeSizeSignal.calculateImpact() needs updating

**Step 5: Commit the type change**

```bash
git add src/signals/types.ts
git commit -m "$(cat <<'EOF'
refactor(signals): change marketPrices to per-token Map

SignalContext.marketPrices is now Map<string, PricePoint[]>
to support multiple tokens per market.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update TradeSizeSignal to Use Map

**Files:**
- Modify: `src/signals/tradeSize.ts`
- Modify: `tests/signals/tradeSize.test.ts`

**Step 1: Test is already written from Task 4**

**Step 2: Update TradeSizeSignal.calculate()**

Change line 9 from:

```typescript
    const { config, marketPrices = [] } = context;
```

To:

```typescript
    const { config, marketPrices } = context;
    const tokenPrices = marketPrices?.get(trade.marketId) ?? [];
```

Change line 27 from:

```typescript
    const impact = this.calculateImpact(trade, marketPrices, impactWindowMinutes);
```

To:

```typescript
    const impact = this.calculateImpact(trade, tokenPrices, impactWindowMinutes);
```

**Step 3: Run test to verify it passes**

Run: `npx vitest run tests/signals/tradeSize.test.ts -v`
Expected: PASS

**Step 4: Run all signal tests to ensure no regression**

Run: `npx vitest run tests/signals/ -v`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/signals/tradeSize.ts tests/signals/tradeSize.test.ts
git commit -m "$(cat <<'EOF'
feat(signals): TradeSizeSignal uses per-token price Map

Looks up prices by trade.marketId from the Map instead of
using a flat array. Impact calculation now works correctly.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Integrate Prices into analyze.ts

**Files:**
- Modify: `src/commands/analyze.ts`

**Step 1: Add import for PriceFetcher**

Add after line 15:

```typescript
import { PriceFetcher } from '../api/prices.js';
```

**Step 2: Add PriceFetcher to AnalyzeCommand constructor**

Add property (around line 46):

```typescript
  private priceFetcher: PriceFetcher;
```

Initialize in constructor (after line 72):

```typescript
    this.priceFetcher = new PriceFetcher(this.tradeDb);
```

**Step 3: Fetch prices before scoring in execute()**

Add helper to determine time range (add as private method):

```typescript
  private getTradeTimeRange(trades: Trade[]): { startTs: number; endTs: number } {
    if (trades.length === 0) {
      const now = Math.floor(Date.now() / 1000);
      return { startTs: now - 300, endTs: now };
    }

    const timestamps = trades.map(t => Math.floor(t.timestamp.getTime() / 1000));
    const buffer = 5 * 60;  // 5 minute buffer
    return {
      startTs: Math.min(...timestamps) - buffer,
      endTs: Math.max(...timestamps) + buffer,
    };
  }
```

After line 176 (after `allTrades` is populated), add:

```typescript
    // Fetch price history for market impact calculation
    let marketPrices: Map<string, import('../signals/types.js').PricePoint[]> | undefined;
    if (allTrades.length > 0 && market.tokens?.length > 0) {
      const tokenIds = market.tokens.map(t => t.tokenId);
      const { startTs, endTs } = this.getTradeTimeRange(allTrades);

      console.log(`Fetching price history for ${tokenIds.length} tokens...`);
      const priceData = await this.priceFetcher.getPricesForMarket(tokenIds, startTs, endTs);

      // Convert to PricePoint format (Date timestamp)
      marketPrices = new Map();
      for (const [tokenId, prices] of priceData) {
        marketPrices.set(tokenId, prices.map(p => ({
          timestamp: new Date(p.timestamp * 1000),
          price: p.price,
        })));
      }

      const totalPrices = [...priceData.values()].reduce((sum, p) => sum + p.length, 0);
      console.log(`  Loaded ${totalPrices} price points`);
    }
```

**Step 4: Pass marketPrices in SignalContext**

Update quickContext (around line 243):

```typescript
        const quickContext: SignalContext = { config: this.config, marketPrices };
```

Update fullContext (around line 375):

```typescript
        const fullContext: SignalContext = {
          config: this.config,
          accountHistory,
          historicalState,
          marketPrices,
        };
```

**Step 5: Run integration test**

Run: `npm run dev -- analyze -m 24918067747661759048720135607687934209172945708698786072564741153847301974566 --debug 2>&1 | head -50`
Expected: Should see "Fetching price history" and non-zero impact scores

**Step 6: Commit**

```bash
git add src/commands/analyze.ts
git commit -m "$(cat <<'EOF'
feat(analyze): integrate price fetching for market impact

Fetches CLOB price history before scoring, passes prices
via SignalContext.marketPrices Map. Impact scores now
reflect actual price movements around trades.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Integrate Prices into investigate.ts

**Files:**
- Modify: `src/commands/investigate.ts`

**Step 1: Add import for PriceFetcher**

Add after line 12:

```typescript
import { PriceFetcher } from '../api/prices.js';
```

**Step 2: Add PriceFetcher to InvestigateCommand**

Add property (around line 51):

```typescript
  private priceFetcher: PriceFetcher;
```

Initialize in constructor (after line 80):

```typescript
    this.priceFetcher = new PriceFetcher(this.tradeDb);
```

**Step 3: Add time range helper**

Add private method:

```typescript
  private getTradeTimeRange(trades: AggregatedTrade[]): { startTs: number; endTs: number } {
    if (trades.length === 0) {
      const now = Math.floor(Date.now() / 1000);
      return { startTs: now - 300, endTs: now };
    }

    const timestamps = trades.map(t => Math.floor(t.timestamp.getTime() / 1000));
    const buffer = 5 * 60;
    return {
      startTs: Math.min(...timestamps) - buffer,
      endTs: Math.max(...timestamps) + buffer,
    };
  }
```

**Step 4: Fetch prices before scoring**

After aggregatedTrades is created (around line 219), add:

```typescript
      // Fetch price history for market impact calculation
      let marketPrices: Map<string, import('../signals/types.js').PricePoint[]> | undefined;
      const tokenIds = [...new Set(aggregatedTrades.map(t => t.marketId))];
      if (tokenIds.length > 0) {
        const { startTs, endTs } = this.getTradeTimeRange(aggregatedTrades);
        const priceData = await this.priceFetcher.getPricesForMarket(tokenIds, startTs, endTs);

        marketPrices = new Map();
        for (const [tokenId, prices] of priceData) {
          marketPrices.set(tokenId, prices.map(p => ({
            timestamp: new Date(p.timestamp * 1000),
            price: p.price,
          })));
        }
      }
```

**Step 5: Pass marketPrices in SignalContext**

Update context (around line 224):

```typescript
      const context: SignalContext = {
        config: this.config,
        accountHistory: accountHistory ?? undefined,
        marketPrices,
      };
```

**Step 6: Run manual test**

Run: `npm run dev -- investigate 0xc37f6aeb073b4b45c2c9ff08a6720391c6ec8033 --market 24918067747661759048720135607687934209172945708698786072564741153847301974566`
Expected: Should show impact scores in trade details

**Step 7: Commit**

```bash
git add src/commands/investigate.ts
git commit -m "$(cat <<'EOF'
feat(investigate): integrate price fetching for market impact

Fetches CLOB price history for all tokens in wallet's trades,
passes via SignalContext for accurate impact scoring.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Add DB Caching Integration Test

**Files:**
- Modify: `tests/db/price-history.test.ts`

**Step 1: Add integration test with PriceFetcher + DB**

Add to `tests/db/price-history.test.ts`:

```typescript
import { PriceFetcher } from '../../src/api/prices.js';

describe('PriceFetcher with DB caching', () => {
  const testDbPath = '.data/test-prices-integration.db';
  let db: TradeDB;
  let fetcher: PriceFetcher;

  beforeEach(() => {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    db = new TradeDB(testDbPath);
    fetcher = new PriceFetcher(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(`${testDbPath}-wal`)) unlinkSync(`${testDbPath}-wal`);
    if (existsSync(`${testDbPath}-shm`)) unlinkSync(`${testDbPath}-shm`);
  });

  it('caches prices in DB after first fetch', async () => {
    // Pre-populate DB to simulate cached data
    db.savePrices('token-cached', [
      { timestamp: 1000, price: 0.5 },
      { timestamp: 2000, price: 0.6 },
    ]);

    // Should return from DB without API call
    const prices = await fetcher.getPricesForToken('token-cached', 500, 2500);
    expect(prices).toHaveLength(2);
  });

  it('returns empty when DB has no data and API unavailable', async () => {
    // No mock, so API will fail
    const prices = await fetcher.getPricesForToken('token-missing', 1000, 2000);
    expect(prices).toEqual([]);
  });
});
```

**Step 2: Run integration tests**

Run: `npx vitest run tests/db/price-history.test.ts -v`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/db/price-history.test.ts
git commit -m "$(cat <<'EOF'
test(db): add PriceFetcher DB caching integration tests

Verifies DB-first caching behavior and graceful degradation
when API is unavailable.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final Verification

**Step 1: Run all tests**

Run: `npm run test:run`
Expected: All tests pass

**Step 2: Test known insider trade (Maduro market)**

Run:
```bash
npm run dev -- analyze -m 24918067747661759048720135607687934209172945708698786072564741153847301974566 -w 0xc37f6aeb073b4b45c2c9ff08a6720391c6ec8033 --debug
```

Expected output should include:
- "Fetching price history for 2 tokens..."
- Non-zero `impactPercent` in trade details (should be ~11.7% for the known trade)

**Step 3: Verify DB caching**

Run the same command again and check:
- Second run should be faster (DB lookup vs API)
- DB should have price_history records: `sqlite3 .data/trades.db "SELECT COUNT(*) FROM price_history"`

**Step 4: Commit final verification**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: complete market impact signal implementation

All tasks verified:
- Price history table with caching
- PriceFetcher with DB-first strategy
- SignalContext.marketPrices as per-token Map
- TradeSizeSignal uses Map lookup
- analyze.ts and investigate.ts integration

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification Checklist

- [x] `npm run test:run` - all existing tests pass (395 tests)
- [x] `npm run dev -- analyze -m <market> --debug` - shows "Fetching price history for 2 tokens..."
- [x] Impact scores are non-zero for trades with price movement
- [x] Maduro market trade shows ~11.7% impact (verified: "Market impact: 11.7% price move -> 50 pts")
- [x] Second run uses cached prices (DB has 2650 price points across 4 tokens)
- [x] `sqlite3 .data/trades.db ".schema price_history"` shows table exists
