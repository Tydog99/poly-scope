# Aggregate Trades Design

**Date:** 2026-01-07
**Status:** Approved
**Branch:** `aggregate-trades`

## Problem Statement

The current system works with individual `EnrichedOrderFilled` events (fills) from the subgraph, but what we really want is to analyze higher-level "trades" (transactions).

**Current flow:**
```
SubgraphAPI → EnrichedOrderFilled events (fills) → Trade[] → Signals → Score per fill
```

**Example:** Our insider made **7 BUY transactions** but they're represented as **~46 fills** (plus ~40 complementary NO sells). Each fill gets scored independently, which:

1. **Inflates counts** - "100 suspicious trades" when really it's 7 decisions
2. **Dilutes scores** - A $7,215 transaction shows up as 9 separate fills with smaller individual values
3. **Adds noise** - The UI shows 46 rows instead of 7

**Proposed flow:**
```
SubgraphAPI → EnrichedOrderFilled events → aggregate by txHash → AggregatedTrade[] → Signals → Score per transaction
```

## Design Decision: Aggregation Granularity

**Decision:** Aggregate by `transactionHash` (one tx = one trade).

**Rationale:** When a taker places a market order, it executes atomically in one transaction. That transaction may have multiple fills (matching different makers), but it represents a single trading decision.

**Research:** Per [Decoding Polymarket Orders](https://yzc.me/x01Crypto/decoding-polymarket):
- One transaction can contain multiple `OrderFilled` events (taker matches multiple makers)
- A maker's limit order can be partially filled across multiple transactions over time
- For taker analysis, `transactionHash` correctly captures the atomic "decision to trade"

**Future consideration:** If detection of intentional order-splitting becomes important (e.g., insider breaks $50k into 10 × $5k orders), we could add optional time-window aggregation (group transactions within N seconds). This is out of scope for initial implementation.

## New Types

### `TradeFill` (represents a single fill event)

```typescript
// src/api/types.ts

export interface TradeFill {
  id: string;              // Original fill ID (txHash-logIndex)
  size: number;            // Shares in this fill
  price: number;           // Price for this fill
  valueUsd: number;        // USD value of this fill
  maker?: string;
  taker?: string;
  role?: 'maker' | 'taker';
}
```

### `AggregatedTrade` (the new primary trade entity)

```typescript
// src/api/types.ts

export interface AggregatedTrade {
  // Identity
  transactionHash: string;  // Primary key for aggregation
  marketId: string;         // Condition ID
  wallet: string;           // The wallet we're analyzing

  // Aggregated values
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  totalSize: number;        // Sum of shares across fills
  totalValueUsd: number;    // Sum of USD value
  avgPrice: number;         // Weighted average price
  timestamp: Date;          // Earliest fill timestamp

  // Fill details (preserved for debugging/UI)
  fills: TradeFill[];
  fillCount: number;

  // Complementary trade metadata (optional, for UI info)
  hadComplementaryFills?: boolean;
  complementaryValueUsd?: number;
}
```

## Aggregation Function

New file `src/api/aggregator.ts`:

```typescript
export interface AggregationOptions {
  wallet: string;                      // Required: whose perspective
  marketTokenIds?: string[];           // For outcome detection
  walletPositions?: SubgraphPosition[]; // For position-based complementary detection
}

export function aggregateFills(
  fills: SubgraphTrade[],
  options: AggregationOptions
): AggregatedTrade[] {
  // 1. Group fills by transactionHash
  // 2. For each tx, separate YES vs NO fills
  // 3. Aggregate each side (sum values, weighted avg price)
  // 4. Detect complementary: if tx has both sides,
  //    keep only the primary (larger value or matches position)
  // 5. Convert to AggregatedTrade with fill details preserved
}
```

### Complementary Detection Logic

When a transaction has both YES and NO fills:

1. If wallet has YES position but not NO → NO side is complementary
2. If wallet has NO position but not YES → YES side is complementary
3. If both or neither → smaller USD value side is complementary

Complementary fills are filtered out during aggregation (not marked and kept).

## Signal Interface Changes

Update signals to receive `AggregatedTrade` instead of `Trade`:

```typescript
// src/signals/types.ts

export interface Signal {
  name: string;
  weight: number;
  calculate(
    trade: AggregatedTrade,  // Changed from Trade
    context: SignalContext
  ): Promise<SignalResult>;
}
```

### Signal Implementation Changes

| Signal | Changes Required |
|--------|------------------|
| `TradeSizeSignal` | `trade.valueUsd` → `trade.totalValueUsd` |
| `ConvictionSignal` | `trade.valueUsd` → `trade.totalValueUsd` |
| `AccountHistorySignal` | None (uses account data, not trade fields) |

## File Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `src/api/types.ts` | Modify | Add `TradeFill`, `AggregatedTrade` types |
| `src/api/aggregator.ts` | **New** | `aggregateFills()` function |
| `src/api/trades.ts` | Modify | Call `aggregateFills()` after fetch |
| `src/signals/types.ts` | Modify | Update `Signal` interface |
| `src/signals/tradeSize.ts` | Modify | Field renames |
| `src/signals/conviction.ts` | Modify | Field renames |
| `src/signals/accountHistory.ts` | None | No changes needed |
| `src/commands/analyze.ts` | Modify | Remove inline aggregation, use new function |
| `src/commands/investigate.ts` | Modify | Use `aggregateFills()` |
| `src/output/cli.ts` | Modify | Field renames, add Fills column |
| `src/output/types.ts` | Modify | Update `SuspiciousTrade.trade` type |

## Testing Strategy

### New Tests

**`tests/api/aggregator.test.ts`:**
- Groups fills by txHash correctly
- Calculates weighted average price
- Sums totalSize and totalValueUsd
- Detects and filters complementary trades (position-based)
- Detects and filters complementary trades (value-based fallback)
- Preserves fill details in output
- Handles single-fill transactions
- Handles empty input

### Existing Tests to Update

- **Signal tests:** Update fixtures from `Trade` to `AggregatedTrade` shape
- **Command tests:** Verify aggregated output counts
- **Integration tests:** May need `fills` array in fixtures

## Migration Approach

Single PR with all changes. The types are interlinked enough that incremental PRs would create intermediate broken states.

## Expected Outcomes

After implementation:

| Metric | Before | After |
|--------|--------|-------|
| Maduro insider trades shown | ~46 fills | 7 transactions |
| Suspicious trade count | Inflated | Accurate |
| Score accuracy | Diluted by fill splitting | Reflects true trade size |
| UI noise | High (many rows) | Low (meaningful rows) |

## Open Questions (Resolved)

1. ~~Should `isComplementary` be on `AggregatedTrade`?~~ **No** - filter during aggregation, don't mark and keep.

2. ~~Can a single order span multiple transactions?~~ **Yes for makers, no for takers.** Aggregating by txHash is correct for taker-focused analysis.
