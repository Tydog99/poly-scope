# The Graph Subgraph Integration Plan

## Overview

Integrate The Graph subgraph API to enhance insider trading detection with on-chain data that isn't available through the Polymarket Data API.

## Goals

1. **Improve Account History Signal** - Use actual account creation dates and trade counts from the blockchain
2. **Access Full Trade History** - Bypass Data API caps for historical analysis
3. **Add Profit/Loss Data** - Incorporate account P&L into suspicion scoring
4. **Cross-Reference Data** - Validate Data API results against on-chain records

## Implementation Steps

### Phase 1: Core Client

**File:** `src/api/subgraph.ts`

```typescript
// GraphQL client for The Graph subgraph
export class SubgraphClient {
  constructor(apiKey: string)

  // Account data
  getAccount(wallet: string): Promise<SubgraphAccount | null>
  getAccountBatch(wallets: string[]): Promise<Map<string, SubgraphAccount>>

  // Trade data
  getTradesByWallet(wallet: string, opts?: TradeQueryOpts): Promise<SubgraphTrade[]>
  getTradesByTimeRange(start: Date, end: Date, opts?: TradeQueryOpts): Promise<SubgraphTrade[]>

  // Positions
  getPositions(wallet: string): Promise<SubgraphPosition[]>
}
```

**Types to add to `src/api/types.ts`:**

```typescript
interface SubgraphAccount {
  id: string
  creationTimestamp: number
  lastSeenTimestamp: number
  collateralVolume: bigint  // 6 decimals
  numTrades: number
  profit: bigint            // 6 decimals, can be negative
}

interface SubgraphTrade {
  transactionHash: string
  timestamp: number
  maker: string
  taker: string
  side: 'Buy' | 'Sell'
  size: bigint    // 6 decimals
  price: bigint   // 6 decimals
}

interface SubgraphPosition {
  marketId: string
  valueBought: bigint
  valueSold: bigint
  netValue: bigint
}
```

### Phase 2: Enhanced Account History Signal

**File:** `src/signals/accountHistory.ts`

Current implementation relies on Data API which lacks:
- Account creation date
- Total trade count across all markets
- Profit/loss history

**Changes:**
1. Add optional `SubgraphClient` parameter to `AccountHistorySignal`
2. If subgraph available, fetch real account data:
   - Use `creationTimestamp` for account age calculation
   - Use `numTrades` for trade count (currently estimates from single market)
   - Use `profit` as additional signal (large profits on new accounts = suspicious)
3. Fall back to Data API estimation if subgraph unavailable

**New scoring factors:**
```typescript
// Account age from blockchain
const accountAgeDays = (now - account.creationTimestamp) / 86400
const ageScore = accountAgeDays < 7 ? 100 : accountAgeDays < 30 ? 70 : accountAgeDays < 90 ? 40 : 0

// Real trade count
const tradeCountScore = account.numTrades < 5 ? 100 : account.numTrades < 20 ? 60 : account.numTrades < 100 ? 30 : 0

// Profit on new account (suspicious if winning big on first trades)
const profitUsd = Number(account.profit) / 1e6
const profitScore = accountAgeDays < 30 && profitUsd > 10000 ? 80 : 0
```

### Phase 3: Trade Data - Subgraph as Primary ✅

**File:** `src/api/trades.ts`

Subgraph is now the primary data source for trade fetching:

```typescript
// TradeFetcher now accepts SubgraphClient
const fetcher = new TradeFetcher({
  subgraphClient,  // Optional - falls back to Data API if not provided
  cache,
});

// Fetch trades with market (includes token IDs for subgraph)
const trades = await fetcher.getTradesForMarket(conditionId, {
  market,  // Required for subgraph - has token IDs
  after,
  before,
  maxTrades,
});
```

**Key changes:**
- `TradeFetcher` accepts optional `SubgraphClient` and uses it as primary when available
- Market object with token IDs is passed to enable subgraph queries
- Falls back to Data API if subgraph fails or is unavailable
- Converts `SubgraphTrade` to internal `Trade` type with proper outcome mapping

### Phase 4: New Command - Wallet Investigation

**File:** `src/commands/investigate.ts`

Add a new CLI command for investigating specific wallets:

```bash
npm run dev -- investigate --wallet 0x31a56e9e690c621ed21de08cb559e9524cdb8ed9
```

Output:
- Account creation date
- Total volume and trade count
- Profit/loss
- All positions
- Recent trade history
- Suspicion score

### Phase 5: Configuration

**File:** `src/config.ts`

```typescript
interface Config {
  // Existing...

  // Subgraph settings
  subgraph: {
    enabled: boolean
    apiKey: string        // from THE_GRAPH_API_KEY env var
    endpoint: string      // default subgraph ID
    timeout: number       // query timeout ms
    retries: number       // retry on indexer failures
  }
}
```

## File Changes Summary

| File | Change |
|------|--------|
| `src/api/subgraph.ts` | New - GraphQL client |
| `src/api/types.ts` | Add subgraph types |
| `src/api/index.ts` | Export subgraph client |
| `src/signals/accountHistory.ts` | Use subgraph for real account data |
| `src/api/trades.ts` | Add subgraph fallback for historical trades |
| `src/commands/investigate.ts` | New - wallet investigation command |
| `src/config.ts` | Add subgraph config |
| `.env.example` | Add THE_GRAPH_API_KEY |

## Testing

1. **Unit tests** for subgraph client with mocked responses
2. **Integration tests** using the Venezuela case wallet
3. **Comparison tests** - verify subgraph data matches Data API where they overlap

## Rollout

1. Subgraph integration is **opt-in** via `THE_GRAPH_API_KEY` env var
2. If key not provided, falls back to current Data API behavior
3. Add `--no-subgraph` flag to disable even when key is present

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Phase 1: Core Client | 2-3 hours |
| Phase 2: Account History Signal | 1-2 hours |
| Phase 3: Trade Fallback | 1-2 hours |
| Phase 4: Investigate Command | 1 hour |
| Phase 5: Configuration | 30 min |
| Testing | 2 hours |
| **Total** | **8-10 hours** |

## Open Questions

1. Should subgraph be the primary data source or just a fallback?
2. How to handle indexer timeouts gracefully?
3. Should we cache subgraph results like we cache Data API trades?
4. Rate limiting strategy for the 100k/month free tier?
