# Point-in-Time Account History Bug

## Summary

The scoring signals use **current** account state (as of today) rather than the account's state **at the time of the analyzed trade**. This causes historical analysis to underestimate the suspiciousness of trades made by accounts that have grown significantly since.

**Status**: Partially fixed (account age), remaining issues documented below.

## Bug Details

### Fixed

| Signal | Field | Issue | Status |
|--------|-------|-------|--------|
| AccountHistorySignal | `accountAgeDays` | Was using `new Date()` instead of `trade.timestamp` | **Fixed** |

### Still Affected

| Signal | Field | Issue | Impact |
|--------|-------|-------|--------|
| AccountHistorySignal | `totalTrades` | Uses current lifetime trade count | First-trade insiders now appear "established" |
| AccountHistorySignal | `profitUsd` | Uses current lifetime profit | Early profits diluted by later losses |
| ConvictionSignal | `totalVolumeUsd` | Uses current lifetime volume | High-conviction bets appear diversified |

## Impact Examples

### Example 1: Trade Count

An insider creates a new account and makes their first suspicious trade on Jan 1, 2024.

| Metric | At Trade Time | Current (Jan 2025) | Effect |
|--------|---------------|-------------------|--------|
| Trade count | 1 | 500 | Score: 0 (established) instead of 33 (first trade) |

### Example 2: Conviction/Concentration

An insider bets $50k on a market when their account only had $100k total volume.

| Metric | At Trade Time | Current | Effect |
|--------|---------------|---------|--------|
| Total volume | $100k | $2M | Concentration: 2.5% instead of 50% |
| Conviction score | ~100 (max) | ~10 (low) | Trade appears diversified |

### Example 3: Profit Rate

An insider makes $50k profit in their first month, then loses money over the next year.

| Metric | At Trade Time | Current | Effect |
|--------|---------------|---------|--------|
| Profit | +$50k | -$10k | profitScore: 0 instead of 25 |
| Account age at trade | 14 days | 400 days | No longer "new account" threshold |

## Root Cause

The `AccountHistory` interface fetches data from the subgraph's `Account` entity, which only stores **current aggregate state**:

```graphql
account(id: $wallet) {
  collateralVolume    # Current lifetime total
  numTrades           # Current lifetime count
  profit              # Current lifetime P&L
  creationTimestamp   # Only timestamp available
}
```

There is no subgraph query for "account state at timestamp X."

## Proposed Fixes

### Option 1: Fetch Historical Trades (Accurate but Expensive)

For each suspicious trade, fetch all the wallet's trades with `timestamp < trade.timestamp` and compute historical metrics.

```typescript
interface HistoricalAccountState {
  tradeCountAtTime: number;
  volumeAtTime: number;
  profitAtTime: number;
}

async function getAccountStateAtTime(
  wallet: string,
  atTimestamp: Date
): Promise<HistoricalAccountState> {
  const trades = await subgraph.getTradesByWallet(wallet, {
    before: atTimestamp,
    limit: 10000,  // Need ALL trades before this time
  });

  return {
    tradeCountAtTime: trades.length,
    volumeAtTime: trades.reduce((sum, t) => sum + t.valueUsd, 0),
    profitAtTime: calculateProfit(trades),  // Complex: needs position tracking
  };
}
```

**Cost Analysis:**

| Account Size | Trades to Fetch | Paginated Queries | Est. Time |
|--------------|-----------------|-------------------|-----------|
| Small (<100) | ~50 | 1 | <1s |
| Medium (100-1000) | ~500 | 1 | 1-2s |
| Large (1000-5000) | ~2500 | 3-5 | 5-15s |
| Whale (5000+) | 5000+ | 5-10+ | 15-60s+ |

**Total cost per analysis:**
- Analyzing 50 suspicious trades from 30 unique wallets
- Average 500 trades per wallet = 15,000 trades to fetch
- ~15 paginated queries minimum
- Could add 30-120 seconds to analysis time

**Subgraph Limitations:**
- Max 1000 results per query (pagination required)
- Rate limiting on The Graph gateway
- Query complexity limits may reject large batches

### Option 2: Approximate Using Trade Timestamps (Cheaper)

Use the trades we already fetched for the market to estimate historical state:

```typescript
function estimateHistoricalTradeCount(
  accountHistory: AccountHistory,
  tradeTimestamp: Date
): number {
  // Assume linear trade activity
  const accountAgeAtTrade = tradeTimestamp - accountHistory.creationDate;
  const totalAccountAge = now - accountHistory.creationDate;
  const ratio = accountAgeAtTrade / totalAccountAge;

  return Math.ceil(accountHistory.totalTrades * ratio);
}
```

**Pros:** No additional queries
**Cons:** Inaccurate for accounts with variable activity (bursty trading, long dormancy)

### Option 3: Hybrid Approach (Recommended)

1. **Quick pass**: Use current metrics for initial scoring
2. **Deep dive**: For trades scoring above threshold (e.g., >60), fetch historical trades to recalculate accurate point-in-time metrics
3. **Cache results**: Store historical calculations per wallet

```typescript
// Phase 1: Quick scoring with current metrics (existing behavior)
const quickScore = await scoreWithCurrentMetrics(trade);

// Phase 2: If suspicious, recalculate with historical data
if (quickScore.total >= DEEP_DIVE_THRESHOLD) {
  const historicalState = await getAccountStateAtTime(trade.wallet, trade.timestamp);
  const accurateScore = await scoreWithHistoricalMetrics(trade, historicalState);
}
```

**Benefits:**
- Only pay the cost for truly suspicious trades
- Most legitimate trades filtered out cheaply
- Catches insider trades that would otherwise be missed

### Option 4: Add Fields to AccountHistory Type

Extend the type to support optional point-in-time fields:

```typescript
interface AccountHistory {
  // Current state (existing)
  totalTrades: number;
  totalVolumeUsd: number;
  profitUsd?: number;

  // Point-in-time state (new, optional)
  tradesAtAnalysisTime?: number;
  volumeAtAnalysisTime?: number;
  profitAtAnalysisTime?: number;
}
```

Signals would prefer `*AtAnalysisTime` fields when available.

## Implementation Priority

1. **High**: Fix ConvictionSignal concentration calculation (biggest impact on detection)
2. **High**: Fix AccountHistorySignal trade count scoring
3. **Medium**: Fix profit scoring (less common case)
4. **Low**: Add caching for historical state calculations

## Testing Considerations

Any fix should include tests that:
1. Set system time far in the future
2. Provide account history with large current values
3. Verify scores reflect state at trade time, not current state

Example test case:
```typescript
it('scores based on trade count at trade time, not current count', async () => {
  // Account has 500 trades NOW but this was their FIRST trade
  const history = {
    totalTrades: 500,  // Current
    tradesAtAnalysisTime: 1,  // At trade time (new field)
    // ...
  };

  const result = await signal.calculate(trade, makeContext(history));

  // Should score as first trade (high suspicion), not established (low)
  expect(result.details.tradeCountScore).toBe(33);  // Max score
});
```

## References

- Original bug fix: Account age calculation (commit TBD)
- `src/signals/accountHistory.ts` - AccountHistorySignal implementation
- `src/signals/conviction.ts` - ConvictionSignal implementation
- `src/api/subgraph.ts` - Subgraph client with trade fetching methods
