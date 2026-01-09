# Project Status - Polymarket Insider Trading Detector

Last updated: 2026-01-08

## 1. Current Implementation - Fully Functional

### Core Architecture
- **Project**: TypeScript CLI tool for detecting insider trading on Polymarket
- **Build Status**: Compiles cleanly with `npm run build` (0 TypeScript errors)
- **Test Status**: All 286 tests passing across 26 test files
- **Code Size**: 2,352 lines of source code (38 TypeScript files)

### Implemented Commands (4)

1. **`analyze`** - Market forensic analysis
   - Analyzes trades for a specific market (by slug or condition ID)
   - Filters by outcome, date range, minimum trade size
   - Supports `--all` flag for multi-market events
   - `-w/--wallet` flag for targeted wallet analysis with verbose scoring output
   - Returns top 10 suspicious trades ranked by score
   - Gracefully handles both resolved and unresolved markets

2. **`investigate`** - Wallet deep-dive
   - Profiles a specific wallet address
   - Shows recent trades and market positions
   - Analyzes suspicion factors (account age, trade count, concentration, profit rate)
   - Runs wallet's trades through the suspicious trade analyzer (same 3-signal system as `analyze`)
   - `--analyze-limit <n>` flag controls how many trades to analyze (default: 100, 0 to disable)
   - `-m/--market` flag filters to a specific market at the GraphQL query level (not post-fetch)

3. **`monitor`** - Real-time market surveillance
   - Watches markets via RTDS WebSocket for suspicious trades
   - Alerts when trades score above threshold (default 70)
   - Quick-filters by minimum trade size (default $5k)
   - Auto-reconnects with exponential backoff
   - Color-coded output: YES (blue), NO (yellow)
   - Uses 5-minute in-memory cache for account lookups

4. **`db`** - Database management commands
   - `db status` - Shows database statistics (file size, table row counts, backfill queue length)
   - `db wallet <address>` - Shows wallet info (creation date, sync window, trade count, backfill status)
   - `db import [--cache-dir <path>]` - Imports trades, accounts, redemptions from JSON cache files (idempotent)
   - `db validate [--cache-dir <path>]` - Validates migration by comparing DB and JSON counts
   - `db cleanup-cache [--cache-dir <path>]` - Removes JSON cache directory (only after validation passes)
   - `db backfill [wallet] [--max <n>]` - Backfill trade history for queued wallets or a specific wallet

### Three Weighted Detection Signals

1. **TradeSizeSignal (40% weight)**
   - Scores based on absolute trade size (logarithmic scaling)
   - Calculates market impact (price change 5-min window around trade)
   - Combines both into 0-100 score
   - Configurable minimum thresholds

2. **AccountHistorySignal (35% weight)**
   - **4-component scoring** (with subgraph data):
     - Trade count (low = suspicious)
     - Account age (new = suspicious)
     - Dormancy (long idle period = suspicious)
     - Profit on new accounts (high returns + new account = very suspicious)
   - **3-component fallback** (without profit data)
   - Subgraph data preferred, Data API fallback
   - Special profit-scoring logic: 50%+ ROI on new accounts = max score

3. **ConvictionSignal (25% weight)**
   - Measures trade size relative to wallet's total trading volume
   - High concentration in single trade = suspicious
   - Handles new wallets with no prior volume

### Data Layer - Dual Source Architecture

**Primary: The Graph Subgraph** (on-chain data)
- Subgraph ID: `81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC`
- Requires API key: `THE_GRAPH_API_KEY` environment variable
- Features:
  - Full historical trade data (no caps)
  - Account creation timestamps (not just first trade)
  - Lifetime profit/loss data
  - Market positions per user
  - Batch queries for efficiency
  - Retry logic with exponential backoff (configurable, default 2 retries)
  - GraphQL query timeout: 30s default

- **Implemented Methods**:
  - `getAccount()` - Single wallet stats
  - `getAccountBatch()` - Multiple wallets in one query
  - `getTradesByWallet()` - Maker + taker trades, supports `marketIds` filter
  - `getTradesByMarket()` - Paginated market trades (1000 per request)
  - `getTradesByCondition()` - Both YES/NO tokens
  - `getTradesByTimeRange()` - Time-filtered trades
  - `getTradesBySize()` - Range-filtered trades (6 decimal precision)
  - `getPositions()` - User's market positions

**Fallback: Polymarket Data API**
- Endpoint: `https://data-api.polymarket.com`
- Features:
  - Public trade data
  - No authentication required
  - Trade cap varies by market (10k-100k trades observed)
  - Pagination via offset
  - No server-side date filtering
  - Caching system (`.cache/trades/`)

### Caching & Performance
- **TradeCache** system stores trades locally in `.cache/trades/`
- Merges new trades with cached data
- Deduplicates by trade ID
- Tracks newest/oldest timestamps for smart backfilling
- **Account Lookups**: Currently NOT cached to ensure fresh profit/volume data; performance is maintained via Subgraph batching.

### Configuration System
- `config.json` at project root
- CLI overrides for weights, thresholds, data sources
- Alert threshold: default 70 (configurable via `--threshold`)
- Minimum trade size: default $5,000 (configurable via `--min-size`)
- Subgraph can be disabled with `--no-subgraph`

---

## 2. Test Coverage Analysis

### Test Suite (1,519 total lines)

| Module | Tests | Status | Notes |
|--------|-------|--------|-------|
| `config.test.ts` | 4 tests | Pass | Config loading, defaults, overrides, monitor config |
| `signals/tradeSize.test.ts` | 4 tests | Pass | Threshold, size scaling, market impact |
| `signals/accountHistory.test.ts` | 10 tests | Pass | All scoring components, edge cases |
| `signals/conviction.test.ts` | 4 tests | Pass | Concentration scoring |
| `signals/aggregator.test.ts` | 5 tests | Pass | Weighted aggregation, alert flagging |
| `api/slug.test.ts` | 3 tests | Pass | Slug resolution, condition ID handling |
| `api/client.test.ts` | 2 tests | Pass | Market fetching |
| `api/trades.test.ts` | 7 tests | Pass | Data API conversion, filtering |
| `api/accounts.test.ts` | 6 tests | Pass | Subgraph fallback, Data API |
| `api/subgraph.test.ts` | 14 tests | Pass | Account queries, trade queries, error handling |
| `commands/analyze.test.ts` | 3 tests | Pass | Market analysis, filtering, account enrichment |
| `integration/analyze.test.ts` | 2 tests | Pass | Real fixture data (Venezuela market) |
| `output/cli.test.ts` | 3 tests | Pass | Report formatting |

### Integration Test Fixture
- Venezuela market data (`tests/fixtures/venezuela-market.json`)
- Used to validate detection accuracy on known insider trading case
- Tests that suspicious wallets are flagged (score > 70)

---

## 3. Missing/Incomplete Features

### Signals Not Yet Implemented

- [ ] **Cross-Market Correlation Signal** - Detect wallets betting same direction across related markets
- [ ] **Position Concentration Signal** - Flag accounts with positions in few markets vs. diversified
- [ ] **Trade Timing Signal** - Identify trades clustered before major price moves
- [ ] **Whale Following Signal** - Detect accounts copying trades from known large wallets

### API Methods Implemented But Not Used

The subgraph client has advanced methods that aren't integrated into the main commands:

- `getTradesByTimeRange()` - Fetch all trades in a date range (across all markets)
- `getTradesBySize()` - Find trades matching specific USD amounts

### Advanced Features Not Implemented

- [ ] Batch wallet investigation (analyze multiple wallets at once)
- [ ] Cross-market analysis (investigate trading patterns across multiple markets)
- [x] ~~Watchlist support~~ - Implemented via `monitor` command config watchlist
- [ ] Persistence layer for investigation results
- [ ] Export formats (CSV, JSON reports)
- [x] ~~Real-time monitoring mode~~ - Implemented via `monitor` command
- [ ] Alert notifications (email, webhook, Discord)

### Auth Module
- ~~`src/api/auth.ts` was removed (unused code for L2 authentication)~~

---

## 4. Scripts

1. **`debug-trades.ts`** - Queries CLOB API with various parameter combinations (orphaned, uses old approach)
2. **`get-api-keys.ts`** - Derives Polymarket API credentials from private key (working utility)

~~`test-subgraph.ts` was deleted (debug script, not needed)~~

---

## 5. Known Issues & Limitations

### Polymarket Data API Trade Caps

- Undocumented, varies by market
- Observed: 100k trades (Maduro market) vs 10k trades (Venezuela market)
- Wrap-around behavior: offsets beyond cap return duplicates

### Data API Limitations

- No server-side date filtering
- Only supports: market, user, limit, offset, side parameters
- CLOB API requires authentication and only returns user's own trades

### Subgraph Limitations

- Some indexers may timeout on large queries
- Market field sometimes undefined in trade responses
- Asset IDs are decimal (not hex condition IDs)
- Query complexity limits apply

### Point-in-Time Analysis Bug (Partially Fixed)

Historical analysis uses **current** account state instead of state **at the time of the analyzed trade**. This can cause insider trades to be missed when analyzing old markets.

| Signal | Field | Status | Impact |
|--------|-------|--------|--------|
| AccountHistorySignal | `accountAgeDays` | **Fixed** | Was using `new Date()` instead of trade timestamp |
| AccountHistorySignal | `totalTrades` | **Fixed** | Uses `historicalState.tradeCount` when available |
| AccountHistorySignal | `profitUsd` | Bug | Early profits diluted by later losses |
| ConvictionSignal | `totalVolumeUsd` | **Fixed** | Uses `historicalState.volume` when available |

See `docs/POINT_IN_TIME_BUG.md` for detailed analysis and proposed fixes.

### Technical Considerations

- Account history preferred from subgraph but falls back gracefully
- Quick score first (without account data), then fetches history for high-scoring trades only
- Limits account fetches to 50 per analysis to avoid API throttling
- Market impact calculation uses 5-minute window (configurable)

---

## 6. Code Quality Assessment

### Strengths
- Clean architecture - Separation of concerns (api, signals, commands, output)
- Comprehensive test suite - 77 tests with integration tests
- Error handling - Graceful fallbacks between data sources
- Configuration - Flexible config system with CLI overrides
- Documentation - Extensive README with limitations documented
- TypeScript strict mode - Full type safety
- No code smells - No TODO/FIXME comments found
- No console warnings - Clean build output

### Areas for Improvement
- Scripts directory has old debug/orphaned scripts
- getTradesByTimeRange/Size methods implemented but not integrated

---

## 7. Dependency Analysis

**Production Dependencies** (6):
- `@polymarket/clob-client` - Official Polymarket SDK
- `@polymarket/real-time-data-client` - WebSocket client for real-time trade data
- `chalk` - Terminal colors
- `commander` - CLI argument parsing
- `dotenv` - Environment variable loading
- `ws` - WebSocket (included via clob-client)

**Dev Dependencies** (5):
- TypeScript, Vitest, tsx, @types packages

**Security**: No known vulnerabilities in dependency chain

---

## 8. Summary: What Works vs What Doesn't

| Feature | Status | Notes |
|---------|--------|-------|
| Market analysis | Working | Top 10 suspicious trades |
| Wallet investigation | Working | Deep-dive profiles |
| Trade size signal | Working | With market impact scoring |
| Account history signal | Working | With profit analysis |
| Conviction signal | Working | Position concentration |
| Subgraph integration | Working | Primary data source |
| Data API fallback | Working | With caching |
| Configuration system | Working | CLI overrides supported |
| Test suite | Working | 200/200 passing |
| Build process | Working | Zero TypeScript errors |
| Cross-market analysis | Not implemented | Planned feature |
| Whale following signal | Not implemented | Planned feature |
| Real-time monitoring | Working | `monitor` command with WebSocket |
| Watchlist feature | Working | Used by `monitor` command |
| Auth for CLOB API | Not implemented | Module exists, not used |
| Batch wallet analysis | Not implemented | Can only analyze one wallet |
| Export formats | Not implemented | CLI only |
| Alerts/notifications | Not implemented | No webhook/email support |
| Advanced subgraph queries | Partial | Size/timerange methods exist but unused |

---

## 9. File Structure

```
src/
├── api/              (Data layer)
│   ├── client.ts     - Polymarket CLOB client wrapper
│   ├── trades.ts     - Trade fetching (subgraph + Data API)
│   ├── accounts.ts   - Account history
│   ├── subgraph.ts   - The Graph GraphQL queries
│   ├── slug.ts       - Market slug resolution
│   ├── market-resolver.ts - Token ID to market name mapping
│   ├── cache.ts      - Trade caching
│   └── types.ts      - Type definitions
├── signals/          (Detection engine)
│   ├── tradeSize.ts  - Trade size scoring
│   ├── accountHistory.ts - Account analysis
│   ├── conviction.ts - Position concentration
│   ├── aggregator.ts - Weighted combination
│   └── types.ts      - Signal types
├── commands/         (CLI commands)
│   ├── analyze.ts    - Market analysis
│   ├── investigate.ts - Wallet investigation
│   └── monitor.ts    - Real-time monitoring command
├── monitor/          (Real-time monitoring)
│   ├── stream.ts     - WebSocket wrapper with reconnection
│   ├── evaluator.ts  - Real-time trade evaluator with session cache
│   └── types.ts      - Monitor type definitions
├── output/           (Formatting)
│   ├── cli.ts        - Terminal output
│   └── types.ts      - Output types
├── config.ts         - Configuration system
└── index.ts          - CLI entry point

tests/ (20 test files, 200 tests)
scripts/ (3 utilities)
docs/ (Planning documents)
```

---

## 10. Roadmap / Next Steps

### Critical
- [x] ~~**Remove 50 account lookups limit**~~ - Implemented two-pass batch fetching with chunked subgraph queries (100 wallets per batch). No longer limited to 50 accounts.

### Immediate (Polish & Cleanup)
- [x] ~~Decide on `scripts/test-subgraph.ts`~~ - deleted
- [x] ~~Remove unused `src/api/auth.ts`~~ - deleted
- [ ] Integrate unused subgraph queries into commands
- [ ] Create test transactions for SELLING YES/NO both high value and low value shares (to verify complementary token filtering)

### Feature Additions
- [ ] Cross-Market Correlation signal
- [ ] Trade Timing signal
- [ ] Whale Following signal
- [ ] Batch wallet investigation command
- [ ] Export formats (JSON/CSV)
- [x] ~~Watchlist support~~ - Implemented via `monitor` command config watchlist
- [x] ~~**Market name resolution**~~ - Fixed! Uses Gamma API `clob_token_ids` param with repeated format.

### Advanced Features
- [x] ~~Real-time monitoring mode~~ - Implemented via `monitor` command
- [ ] Alert notifications (webhooks, Discord, email)
- [ ] Persistence layer for results
- [ ] Web dashboard

---

## Progress Log

| Date | Change |
|------|--------|
| 2026-01-04 | Initial status document created |
| 2026-01-04 | Deleted unused `scripts/test-subgraph.ts` and `src/api/auth.ts` |
| 2026-01-05 | Added tabular output with score breakdown, colored repeat wallets, time column |
| 2026-01-05 | Added OSC 8 hyperlinks for copyable wallet addresses |
| 2026-01-05 | Added `--top` CLI option (default 50) |
| 2026-01-05 | Merged cli-updates branch into main |
| 2026-01-05 | Implemented two-pass batch fetching to remove 50-account limit |
| 2026-01-05 | Fixed broken Account entities by querying actual trade counts from enrichedOrderFilleds |
| 2026-01-05 | Optimized market resolver: switched from CLOB to Gamma API, lazy loading |
| 2026-01-05 | Fixed market name resolution: use repeated params format for Gamma API clob_token_ids |
| 2026-01-05 | Enhanced investigate output: P&L table with cost basis, trading P&L, realized gains, redemptions |
| 2026-01-05 | Fixed wallet action determination (maker vs taker side interpretation) |
| 2026-01-05 | Added CLOB documentation to CLAUDE.md |
| 2026-01-05 | Fixed complementary token filtering: uses position data to show YES or NO trades based on wallet holdings |
| 2026-01-06 | Enhanced investigate: runs wallet trades through 3-signal suspicious trade analyzer with `--analyze-limit` flag |
| 2026-01-06 | Fixed trade side interpretation bug: now properly inverts `side` field for takers (was using maker's side directly) |
| 2026-01-06 | Added `--role` flag for analyze command: taker (default), maker, or both - avoids double-counting per Paradigm research |
| 2026-01-06 | Added Trade Data Interpretation documentation to README.md with research links |
| 2026-01-06 | Fixed investigate `-m` market filter: now filters at GraphQL query level instead of post-fetch (was missing trades when wallet had many trades in other markets) |
| 2026-01-06 | Enhanced investigate Recent Trades: shows both maker [M] and taker [T] fills with role indicators, marks complementary trades [C], includes breakdown in totals |
| 2026-01-06 | Fixed complementary trade detection: now works at transaction level - when a tx has both YES/NO trades, the smaller value side is marked [C] (order routing artifact) |
| 2026-01-06 | Exclude complementary trades from market subtotals - they're order routing artifacts, not primary intent |
| 2026-01-06 | Fixed P&L calculation: now uses `valueSold - valueBought` instead of `netValue` directly (negative netValue = profit, was confusing) |
| 2026-01-06 | Fixed trading P&L for held positions: shows "held" (not "unrealized") and counts as $0 P&L instead of negative cost basis |
| 2026-01-06 | Added ROI column to Positions table: shows per-market ROI calculated from (valueSold + redemption - cost) / cost |
| 2026-01-06 | Merged Redemptions into Positions table: realized gains now shown inline, removed separate Redemptions section |
| 2026-01-06 | Added sync-issue detection: shows "(sync-issue)" when position has redemption but still shows remaining shares |
| 2026-01-06 | Fixed candidate threshold mismatch: now uses `alertThreshold - 10` instead of hardcoded 60, ensuring all potentially flagged trades get account data fetched |
| 2026-01-06 | Added `--debug` flag to analyze command: shows detailed score breakdowns for each suspicious trade |
| 2026-01-06 | Added graceful fallback for subgraph indexer failures: estimates trade counts from volume when indexers unavailable |
| 2026-01-07 | Added redemption caching to `.cache/redemptions/` - survives failed runs |
| 2026-01-07 | Enabled account/redemption caching by default (use `--no-cache` to disable) |
| 2026-01-07 | Added progress timing to all batch operations (shows last query time + ETA) |
| 2026-01-07 | Added trade count caching to `.cache/trade-counts/` with incremental saves after each batch |
| 2026-01-07 | Added `-w/--wallet` filter to analyze command: filters trades to specific wallet, shows all trades (not just alerts), skips safe bet filter |
| 2026-01-07 | Added `formatWalletAnalysis` output function for verbose wallet-targeted analysis: account header, trades summary table, detailed signal breakdowns |
| 2026-01-07 | Added `@polymarket/real-time-data-client` dependency (v1.4.0) for real-time monitoring feature |
| 2026-01-07 | Added monitor type definitions (`src/monitor/types.ts`): RTDSTradeEvent, EvaluatedTrade, MonitorConfig, ConnectionState, MonitorOptions |
| 2026-01-07 | Added monitor configuration to config system: maxReconnects, retryDelaySeconds, stabilityThresholdSeconds, backoff settings with defaults |
| 2026-01-07 | Added WebSocket stream wrapper (`src/monitor/stream.ts`): MonitorStream class with exponential backoff reconnection, ConnectionStatus handling, stability timer for reset |
| 2026-01-07 | Added trade evaluator (`src/monitor/evaluator.ts`): MonitorEvaluator class with session cache (5-min TTL), reuses existing signals (TradeSizeSignal, AccountHistorySignal, ConvictionSignal), normalizes RTDSTradeEvent to Trade type |
| 2026-01-07 | Added monitor output formatters (`src/output/cli.ts`): `formatMonitorTrade()` for verbose trade lines, `formatMonitorAlert()` for full alert with signal breakdown, `formatMonitorBanner()` for startup display. YES=blue, NO=yellow colors. |
| 2026-01-07 | Added monitor command (`src/commands/monitor.ts`): `executeMonitor()` ties together MonitorStream, MonitorEvaluator, AccountFetcher. Supports -m markets, --min-size, --threshold, --verbose flags. Graceful shutdown on SIGINT. Resolves slugs via SlugResolver before subscribing. |
| 2026-01-07 | Added `TradeFill` and `AggregatedTrade` types for transaction-level trade aggregation |
| 2026-01-07 | Added `aggregateFills` function in `src/api/aggregator.ts` with basic grouping by transaction hash |
| 2026-01-07 | Added weighted average price test for aggregateFills in `tests/api/aggregator.test.ts` |
| 2026-01-07 | Added complementary trade detection to aggregator: filters smaller USD value side when tx has both YES/NO, uses position data to override when wallet has directional position |
| 2026-01-07 | Added edge case tests for aggregator: single-fill transactions, empty input, multiple separate transactions, maker vs taker role determination, side inversion for takers |
| 2026-01-07 | Updated Signal interface to use AggregatedTrade type with new field names (totalValueUsd, totalSize, avgPrice); typecheck fails until signals are updated (Tasks 7-9) |
| 2026-01-07 | Updated TradeSizeSignal to use AggregatedTrade: valueUsd -> totalValueUsd, added fillCount to details |
| 2026-01-07 | Updated AccountHistorySignal to use AggregatedTrade type (Task 9); 23 tests pass |
| 2026-01-07 | Updated ConvictionSignal to use AggregatedTrade: valueUsd -> totalValueUsd, simplified scoring with concentration-based thresholds |
| 2026-01-07 | Updated output types (SuspiciousTrade, AnalysisReport) to use AggregatedTrade instead of Trade type |
| 2026-01-07 | Updated CLI output to use AggregatedTrade fields: valueUsd -> totalValueUsd, price -> avgPrice |
| 2026-01-07 | Refactored analyze command to use `aggregateFills()` in wallet mode: replaced ~80 lines of inline aggregation with centralized function call |
| 2026-01-07 | Updated TradeClassifier to use AggregatedTrade fields: valueUsd -> totalValueUsd |
| 2026-01-07 | Updated analyze tests to use new field names: id -> transactionHash, price -> avgPrice, valueUsd -> totalValueUsd, size -> totalSize |
| 2026-01-07 | Refactored investigate command to use `aggregateFills()`: removed `convertToTrade` method, now aggregates wallet trades by transaction and filters complementary trades |
| 2026-01-07 | Fixed type errors in cache.ts: changed `trade.id` to `trade.transactionHash` for deduplication |
| 2026-01-07 | Fixed type errors in trades.ts: updated `convertSubgraphTrade` and `convertDataApiTrade` to return full AggregatedTrade objects with fills array |
| 2026-01-07 | Updated all test fixtures to use AggregatedTrade shape: trades.test.ts, cli.test.ts, integration/analyze.test.ts |
| 2026-01-07 | Updated integration test to use lower alertThreshold (60) to match candidate threshold calculation |
| 2026-01-07 | **Aggregate Trades Implementation Complete**: All 15 tasks done, 200 tests pass, signals now score transactions instead of individual fills |
| 2026-01-08 | Fixed weight display bug: removed erroneous `* 100` multiplication (was showing 4000% instead of 40%) |
| 2026-01-08 | Fixed signal score formatting: removed `/100` suffixes, added proper column padding for table alignment |
| 2026-01-08 | Fixed outcome detection: added `outcomeIndex` to ResolvedToken, now uses index-based mapping instead of string matching (fixes non-binary markets like "Up"/"Down") |
| 2026-01-08 | Fixed account age calculation bug: now uses trade timestamp instead of current date for historical analysis |
| 2026-01-08 | Added 4 tests for point-in-time account age calculation |
| 2026-01-08 | Documented remaining point-in-time bugs in `docs/POINT_IN_TIME_BUG.md`: trade count, profit, and conviction concentration still use current state |
| 2026-01-08 | Added `better-sqlite3` dependency (v12.5.0) and TypeScript types for SQLite database layer (Phase 1 of trade database implementation) |
| 2026-01-08 | Added SQLite schema (`src/db/schema.ts`) with trades, accounts, redemptions, markets, backfill_queue tables; WAL mode enabled; 5 tests pass |
| 2026-01-08 | Added TradeDB class (`src/db/index.ts`) with initialization and status methods; creates directories automatically; 3 tests pass |
| 2026-01-08 | Added trade CRUD operations: `saveTrades()` with idempotent INSERT OR IGNORE, `getTradesForWallet()` with optional timestamp filter, `getTradesForMarket()`; 9 tests pass |
| 2026-01-08 | Added account CRUD operations: `saveAccount()` with INSERT OR REPLACE, `getAccount()`, `updateSyncedTo()`, `markComplete()`; sync watermarks for point-in-time queries; 16 tests pass |
| 2026-01-08 | Added point-in-time query: `getAccountStateAt(wallet, timestamp)` returns trade count, volume, P&L at any historical moment; marks results as approximate when data incomplete; 23 tests pass |
| 2026-01-08 | Added redemption operations: `saveRedemptions()` with INSERT OR IGNORE, `getRedemptionsForWallet()` for P&L calculations; 30 tests pass |
| 2026-01-08 | Added backfill queue operations: `queueBackfill()`, `getBackfillQueue()` ordered by priority DESC, `markBackfillStarted()`, `markBackfillComplete()`, `hasQueuedBackfill()`; 30 tests pass |
| 2026-01-08 | Added `db status` CLI command: shows database file size, trade/account/redemption/market counts, backfill queue length |
| 2026-01-08 | Added `db wallet <address>` CLI command: shows wallet creation date, sync window, trade count, backfill status |
| 2026-01-08 | Added migration module (`src/db/migrate.ts`): `importJsonCaches()` imports trades/accounts/redemptions from `.cache/` JSON files, `validateMigration()` compares DB counts with JSON file counts; idempotent imports with 6-decimal scaling; 5 tests pass |
| 2026-01-08 | Added `db import`, `db validate`, `db cleanup-cache` CLI commands for three-step migration workflow from JSON cache to SQLite |
| 2026-01-08 | Added DBAccountFetcher (`src/api/db-accounts.ts`): helper class for database-aware account fetching - retrieves cached accounts from DB, converts DB format to AccountHistory format, detects stale data (default 1hr TTL), saves subgraph data to DB cache; 11 tests pass |
| 2026-01-08 | Integrated TradeDB into AccountFetcher (`src/api/accounts.ts`): optional `tradeDb` option, checks DB first with 1-hour freshness window, saves fetched data back to DB; backward compatible - existing code without tradeDb works unchanged; 272 tests pass |
| 2026-01-08 | Added `historicalState` field to SignalContext (`src/signals/types.ts`): optional point-in-time state (tradeCount, volume, pnl, approximate) from database for accurate historical analysis; Phase 4 of trade database implementation |
| 2026-01-08 | Updated AccountHistorySignal to use `historicalState.tradeCount` when available: falls back to `accountHistory.totalTrades` for backward compatibility; reports `historicalTradeCount: true` in details when using point-in-time data; 3 new tests added (275 total); Task 4.2 complete |
| 2026-01-08 | Updated ConvictionSignal to use `historicalState.volume` when available: converts from 6-decimal scaled integer to USD; falls back to `accountHistory.totalVolumeUsd` for backward compatibility; reports `usingHistoricalState: true` in details; 2 new tests added (277 total); Task 4.3 complete |
| 2026-01-08 | Added backfill runner (`src/db/backfill.ts`): `runBackfill()` processes queued wallets in priority order with configurable limits, `backfillWallet()` fetches all historical trades from subgraph with pagination and saves to DB, graceful error handling (doesn't mark complete on failure); 9 tests added (286 total); Task 5.1 complete |
| 2026-01-08 | Added `db backfill` CLI command: `db backfill` processes queued wallets (default 10), `db backfill 0x...` backfills specific wallet, `--max <n>` limits wallets to process; requires THE_GRAPH_API_KEY; Task 5.2 complete |
