# Enriched Order Fills Design

## Overview

Replace the `trades` table with `enriched_order_fills` to store raw subgraph data instead of derived/computed values. This keeps the database schema aligned with the source data and fixes the bug where one `EnrichedOrderFilled` was incorrectly stored as two rows with `-maker`/`-taker` suffixes.

**Key principle:** 1 subgraph `EnrichedOrderFilled` = 1 database row

## Schema

```sql
CREATE TABLE enriched_order_fills (
  id TEXT PRIMARY KEY,           -- Subgraph fill ID (unique per fill)
  transaction_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,    -- Unix seconds
  order_hash TEXT NOT NULL,
  side TEXT NOT NULL,            -- 'Buy' or 'Sell' (maker's side)
  size INTEGER NOT NULL,         -- 6 decimals
  price INTEGER NOT NULL,        -- 6 decimals (0-1 scaled)
  maker TEXT NOT NULL,           -- Maker wallet (lowercase)
  taker TEXT NOT NULL,           -- Taker wallet (lowercase)
  market TEXT NOT NULL           -- Token/Orderbook ID
);

CREATE INDEX idx_fills_maker_time ON enriched_order_fills(maker, timestamp);
CREATE INDEX idx_fills_taker_time ON enriched_order_fills(taker, timestamp);
CREATE INDEX idx_fills_market ON enriched_order_fills(market, timestamp);
CREATE INDEX idx_fills_tx ON enriched_order_fills(transaction_hash);
```

**Differences from old `trades` table:**
- Removed: `wallet`, `action`, `role`, `value_usd` (all derived)
- Added: `order_hash`, separate `maker`/`taker` columns
- No duplication: one row per subgraph entity

## TradeDB Interface

**Type:**
```typescript
export interface DBEnrichedOrderFill {
  id: string;
  transactionHash: string;
  timestamp: number;
  orderHash: string;
  side: 'Buy' | 'Sell';
  size: number;         // 6 decimals
  price: number;        // 6 decimals
  maker: string;
  taker: string;
  market: string;
}
```

**Methods:**
```typescript
// Save fills (idempotent via INSERT OR IGNORE)
saveFills(fills: DBEnrichedOrderFill[]): number;

// Query fills for a wallet (as maker, taker, or both)
getFillsForWallet(wallet: string, options?: {
  before?: number;
  role?: 'maker' | 'taker' | 'both';
  limit?: number;
}): DBEnrichedOrderFill[];

// Query fills for a market
getFillsForMarket(market: string): DBEnrichedOrderFill[];
```

**Computed values:** `value_usd = size * price / 1e6` is calculated at query time or in the application layer, not stored.

**Aggregation:** The `AggregatedTrade` logic in `src/api/aggregator.ts` handles combining fills by `transactionHash` - this stays in the application layer.

## Files to Change

**Database layer:**
| File | Change |
|------|--------|
| `src/db/schema.ts` | Replace `trades` table with `enriched_order_fills` |
| `src/db/index.ts` | Replace `DBTrade` with `DBEnrichedOrderFill`, rename methods |

**API layer:**
| File | Change |
|------|--------|
| `src/api/trades.ts` | Update `saveTradesFromFills()` to save raw fills |

**Commands:**
| File | Change |
|------|--------|
| `src/commands/analyze.ts` | Update DB calls to use new method names |
| `src/commands/investigate.ts` | Update DB calls to use new method names |

**Tests:**
| File | Change |
|------|--------|
| `tests/db/schema.test.ts` | Update table name assertions |
| `tests/db/index.test.ts` | Update to test new methods/types |
| `tests/integration/db-save-trades.test.ts` | Update to match new schema |

**Not changing:**
- `src/api/aggregator.ts` - already handles combining fills
- Signal calculations - work with `AggregatedTrade`, not raw fills
- Migration module - reimport from `.cache` files

## Implementation Sequence

1. Update schema (`src/db/schema.ts`)
2. Update TradeDB class (`src/db/index.ts`)
3. Update tests (`tests/db/`)
4. Update API layer (`src/api/trades.ts`)
5. Update commands (`src/commands/`)
6. Delete old database and reimport from `.cache`

## Data Migration

No migration needed. Delete `.data/trades.db` and reimport from existing `.cache` files after implementation is complete.
