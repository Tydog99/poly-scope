# Trade Database Design

## Overview

Replace JSON file caching with SQLite to enable point-in-time account state queries, accelerate repeat analysis, and build historical trade data over time.

**Key decisions:**
- SQLite with `better-sqlite3` (door open to DuckDB later)
- Store raw data only, compute scores on-the-fly
- Tiered fetching with background backfill for whale wallets
- One-time migration from JSON caches with validation

## Schema

All financial fields use INTEGER with 6 decimal scaling (divide by 1,000,000 for display), matching subgraph conventions.

```sql
-- Core trade data (one row per fill)
CREATE TABLE trades (
  id TEXT PRIMARY KEY,           -- Fill ID from subgraph
  tx_hash TEXT NOT NULL,         -- Transaction hash
  wallet TEXT NOT NULL,          -- Trader address (lowercase)
  market_id TEXT NOT NULL,       -- Token ID
  timestamp INTEGER NOT NULL,    -- Unix seconds
  side TEXT NOT NULL,            -- 'Buy' or 'Sell' (maker's side)
  action TEXT NOT NULL,          -- 'BUY' or 'SELL' (wallet's action)
  role TEXT NOT NULL,            -- 'maker' or 'taker'
  size INTEGER NOT NULL,         -- 6 decimals (shares)
  price INTEGER NOT NULL,        -- 6 decimals (0-1 scaled)
  value_usd INTEGER NOT NULL     -- 6 decimals (USD)
);

-- Wallet metadata
CREATE TABLE accounts (
  wallet TEXT PRIMARY KEY,
  creation_timestamp INTEGER,    -- From subgraph Account entity

  -- Sync watermarks
  synced_from INTEGER,           -- Oldest trade timestamp we have
  synced_to INTEGER,             -- Newest trade timestamp we have
  synced_at INTEGER,             -- When we last fetched

  -- From subgraph (current state)
  trade_count_total INTEGER,
  collateral_volume INTEGER,     -- 6 decimals
  profit INTEGER,                -- 6 decimals

  -- Completeness
  has_full_history INTEGER DEFAULT 0  -- 1 if synced_from <= creation_timestamp
);

-- For profit calculation
CREATE TABLE redemptions (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payout INTEGER NOT NULL        -- 6 decimals
);

-- Market metadata cache
CREATE TABLE markets (
  token_id TEXT PRIMARY KEY,
  condition_id TEXT,
  question TEXT,
  outcome TEXT,                  -- 'Yes' or 'No'
  outcome_index INTEGER,
  resolved_at INTEGER
);

-- Background job queue
CREATE TABLE backfill_queue (
  wallet TEXT PRIMARY KEY,
  priority INTEGER DEFAULT 0,
  created_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX idx_trades_wallet_time ON trades(wallet, timestamp);
CREATE INDEX idx_trades_market ON trades(market_id, timestamp);
CREATE INDEX idx_redemptions_wallet ON redemptions(wallet);
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Commands                              │
│            (analyze, investigate, monitor)               │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                   TradeDB                                │
│  - getTradesForWallet(wallet, before?) → Trade[]         │
│  - getAccountStateAt(wallet, atTime) → AccountState      │
│  - saveTrades(trades[])                                  │
│  - queueBackfill(wallet)                                 │
│  - isComplete(wallet) → boolean                          │
└─────────────────────┬───────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          │                       │
┌─────────▼─────────┐   ┌─────────▼─────────┐
│   SQLite (local)   │   │  Subgraph (remote) │
│   - Cached trades  │   │  - Fresh data      │
│   - Fast queries   │   │  - Backfill source │
└───────────────────┘   └───────────────────┘
```

**Read path:** Check SQLite first. If wallet `synced_to` is stale, fetch newer trades from subgraph and merge.

**Write path:** All trades fetched from subgraph get written to SQLite before being returned to caller.

**Point-in-time queries:** Served from SQLite. If `synced_from` doesn't cover the requested timestamp, results are marked as approximate.

## Sync Watermarks

Instead of a boolean `is_complete`, we track temporal watermarks:

- `synced_from` - Oldest trade timestamp we have
- `synced_to` - Newest trade timestamp we have
- `synced_at` - When we last fetched from subgraph
- `has_full_history` - True only when `synced_from <= creation_timestamp`

This enables:
- Fetching newer trades when `synced_to` is stale
- Knowing how far back point-in-time queries are accurate
- Backfilling older history on demand

## Background Backfill

For wallets with thousands of trades, we fetch 1000 immediately and queue the rest.

**Backfill triggers:**

| Context | When | Behavior |
|---------|------|----------|
| `analyze` | After analysis completes | Drain up to 5 queued wallets |
| `investigate` | Immediately for target wallet | Blocking - fetch full history before showing results |
| `monitor` | During idle periods | Opportunistic - drain queue when no trades for 30s |
| `backfill` | Manual command | Drain entire queue or specific wallet |

## Migration from JSON Caches

Three-step process with validation:

**Step 1: Import (non-destructive, idempotent)**
```bash
./dist/index.js db import
```
Uses `INSERT OR IGNORE` so running multiple times is safe.

**Step 2: Validate**
```bash
./dist/index.js db validate
```
Confirms DB record counts exactly match JSON file counts.

**Step 3: Delete (explicit, separate)**
```bash
./dist/index.js db cleanup-cache
```
Only succeeds if validation passes.

## CLI Commands

```bash
# Database info
./dist/index.js db status

# Import from JSON cache (idempotent)
./dist/index.js db import

# Validate migration
./dist/index.js db validate

# Delete old JSON cache (after validation)
./dist/index.js db cleanup-cache

# Manual backfill
./dist/index.js db backfill [wallet]

# Query helpers (debugging)
./dist/index.js db wallet <address>
```

## Error Handling

- **DB file corrupted:** Detect on open, offer to rebuild from subgraph
- **Disk full:** Catch write error, warn user, continue with in-memory only
- **Concurrent access:** WAL mode handles reads during writes
- **Subgraph down during backfill:** Mark wallet as incomplete, retry next time
- **Partial backfill interrupted:** `synced_from` reflects progress; resumes from there

**Graceful degradation:** When point-in-time data isn't available, return results with `approximate: true` flag so signals can adjust confidence.

## File Structure

```
src/
├── db/
│   ├── index.ts          -- TradeDB class (main interface)
│   ├── schema.ts         -- Table definitions, migrations
│   ├── queries.ts        -- Prepared statements
│   └── migrate.ts        -- JSON cache → SQLite importer
├── api/
│   ├── accounts.ts       -- Modified: check DB first
│   ├── trades.ts         -- Modified: check DB first
│   └── ...existing...
```

Database location: `.data/trades.db`

## Implementation Phases

**Phase 1: Foundation**
- Add `better-sqlite3` dependency
- Create `src/db/schema.ts` with table definitions
- Create `src/db/index.ts` with TradeDB class (basic CRUD)
- Add `db status` command to verify it works

**Phase 2: Migration**
- Create `src/db/migrate.ts` for JSON import
- Add `db import`, `db validate`, `db cleanup-cache` commands
- Test with existing cache files

**Phase 3: Integration**
- Modify `AccountFetcher` to check DB first
- Modify trade fetching to save to DB
- Add sync watermark tracking

**Phase 4: Point-in-Time**
- Add `getAccountStateAt(wallet, timestamp)` method
- Update `AccountHistorySignal` to use historical state
- Update `ConvictionSignal` to use historical volume
- Add `approximate` flag to signal results

**Phase 5: Backfill**
- Add `backfill_queue` table and methods
- Add `db backfill` command
- Integrate backfill triggers into `analyze`, `investigate`, `monitor`

**Phase 6: Cleanup**
- Remove old cache classes (`TradeCache`, `AccountCache`, etc.)
- Remove `.cache/` references
- Update tests
