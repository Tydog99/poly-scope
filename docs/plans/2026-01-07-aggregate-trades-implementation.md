# Aggregate Trades Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Aggregate EnrichedOrderFilled events (fills) into AggregatedTrade entities by transaction hash, so signals score transactions instead of individual fills.

**Architecture:** Add new types (`TradeFill`, `AggregatedTrade`) and a central `aggregateFills()` function in the data layer. Update signals to use the new type. Remove inline aggregation from commands.

**Tech Stack:** TypeScript, Vitest, The Graph subgraph

**Design Doc:** `docs/plans/2026-01-07-aggregate-trades-design.md`

---

## Task 1: Add New Types

**Files:**
- Modify: `src/api/types.ts`

**Step 1: Add TradeFill and AggregatedTrade types**

Add to end of `src/api/types.ts`:

```typescript
// Aggregated trade types

export interface TradeFill {
  id: string;              // Original fill ID (txHash-logIndex)
  size: number;            // Shares in this fill
  price: number;           // Price for this fill
  valueUsd: number;        // USD value of this fill
  timestamp: number;       // Unix timestamp
  maker?: string;
  taker?: string;
  role?: 'maker' | 'taker';
}

export interface AggregatedTrade {
  // Identity
  transactionHash: string;  // Primary key for aggregation
  marketId: string;         // Token ID (for subgraph) or condition ID
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

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors)

**Step 3: Commit**

```bash
git add src/api/types.ts
git commit -m "feat: add TradeFill and AggregatedTrade types"
```

---

## Task 2: Create Aggregator with Basic Grouping Test

**Files:**
- Create: `src/api/aggregator.ts`
- Create: `tests/api/aggregator.test.ts`

**Step 1: Write the failing test for basic grouping**

Create `tests/api/aggregator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { aggregateFills } from '../../src/api/aggregator.js';
import type { SubgraphTrade } from '../../src/api/types.js';

describe('aggregateFills', () => {
  const baseOptions = {
    wallet: '0xinsider',
    tokenToOutcome: new Map([
      ['token-yes', 'YES' as const],
      ['token-no', 'NO' as const],
    ]),
  };

  describe('basic grouping', () => {
    it('groups fills by transaction hash', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell', // Maker sells, so taker buys
          size: '1000000000', // $1000 (6 decimals)
          price: '0.10',
        },
        {
          id: '0xtx1-1',
          transactionHash: '0xtx1',
          timestamp: 1001,
          maker: '0xmaker2',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '2000000000', // $2000
          price: '0.10',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      expect(result).toHaveLength(1);
      expect(result[0].transactionHash).toBe('0xtx1');
      expect(result[0].fillCount).toBe(2);
      expect(result[0].totalValueUsd).toBe(3000);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/aggregator.test.ts`
Expected: FAIL with "aggregateFills is not exported"

**Step 3: Write minimal implementation**

Create `src/api/aggregator.ts`:

```typescript
import type { SubgraphTrade, SubgraphPosition, AggregatedTrade, TradeFill } from './types.js';

export interface AggregationOptions {
  wallet: string;
  tokenToOutcome: Map<string, 'YES' | 'NO'>;
  walletPositions?: SubgraphPosition[];
}

export function aggregateFills(
  fills: SubgraphTrade[],
  options: AggregationOptions
): AggregatedTrade[] {
  const { wallet, tokenToOutcome } = options;
  const walletLower = wallet.toLowerCase();

  // Group fills by transactionHash + outcome
  const groups = new Map<string, SubgraphTrade[]>();

  for (const fill of fills) {
    const txHash = fill.transactionHash;
    const outcome = tokenToOutcome.get(fill.marketId.toLowerCase()) ?? 'YES';
    const key = `${txHash}|${outcome}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(fill);
  }

  // Convert each group to AggregatedTrade
  const result: AggregatedTrade[] = [];

  for (const [key, groupFills] of groups) {
    const [txHash, outcome] = key.split('|') as [string, 'YES' | 'NO'];
    const firstFill = groupFills[0];

    // Determine wallet's role and side
    const isMaker = firstFill.maker.toLowerCase() === walletLower;
    const role: 'maker' | 'taker' = isMaker ? 'maker' : 'taker';
    // Maker's side matches field; taker's side is opposite
    const side: 'BUY' | 'SELL' = isMaker
      ? (firstFill.side === 'Buy' ? 'BUY' : 'SELL')
      : (firstFill.side === 'Buy' ? 'SELL' : 'BUY');

    // Aggregate values
    let totalValueUsd = 0;
    let totalSize = 0;
    let earliestTimestamp = Infinity;
    const tradeFills: TradeFill[] = [];

    for (const fill of groupFills) {
      const valueUsd = parseFloat(fill.size) / 1e6;
      const price = parseFloat(fill.price);
      const size = price > 0 ? valueUsd / price : 0;

      totalValueUsd += valueUsd;
      totalSize += size;
      earliestTimestamp = Math.min(earliestTimestamp, fill.timestamp);

      tradeFills.push({
        id: fill.id,
        size,
        price,
        valueUsd,
        timestamp: fill.timestamp,
        maker: fill.maker,
        taker: fill.taker,
        role,
      });
    }

    // Weighted average price
    const avgPrice = totalSize > 0 ? totalValueUsd / totalSize : 0;

    result.push({
      transactionHash: txHash,
      marketId: firstFill.marketId,
      wallet: walletLower,
      side,
      outcome,
      totalSize,
      totalValueUsd,
      avgPrice,
      timestamp: new Date(earliestTimestamp * 1000),
      fills: tradeFills,
      fillCount: tradeFills.length,
    });
  }

  // Sort by timestamp descending
  result.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/aggregator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/aggregator.ts tests/api/aggregator.test.ts
git commit -m "feat: add aggregateFills with basic grouping"
```

---

## Task 3: Add Weighted Average Price Test

**Files:**
- Modify: `tests/api/aggregator.test.ts`

**Step 1: Write the failing test**

Add to `tests/api/aggregator.test.ts` inside the describe block:

```typescript
  describe('price calculation', () => {
    it('calculates weighted average price', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '1000000000', // $1000 at 0.10 = 10000 shares
          price: '0.10',
        },
        {
          id: '0xtx1-1',
          transactionHash: '0xtx1',
          timestamp: 1001,
          maker: '0xmaker2',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '2000000000', // $2000 at 0.20 = 10000 shares
          price: '0.20',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      // Total: $3000, 20000 shares → avg price = $3000/20000 = $0.15
      expect(result[0].avgPrice).toBeCloseTo(0.15, 5);
      expect(result[0].totalSize).toBeCloseTo(20000, 0);
    });
  });
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run tests/api/aggregator.test.ts`
Expected: PASS (implementation already handles this)

**Step 3: Commit**

```bash
git add tests/api/aggregator.test.ts
git commit -m "test: add weighted average price test for aggregator"
```

---

## Task 4: Add Complementary Trade Detection

**Files:**
- Modify: `src/api/aggregator.ts`
- Modify: `tests/api/aggregator.test.ts`

**Step 1: Write the failing test for complementary detection**

Add to `tests/api/aggregator.test.ts`:

```typescript
  describe('complementary trade filtering', () => {
    it('filters complementary trades when tx has both YES and NO (smaller value)', () => {
      const fills: SubgraphTrade[] = [
        // YES side: $5000
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '5000000000',
          price: '0.10',
        },
        // NO side: $500 (complementary - smaller)
        {
          id: '0xtx1-1',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker2',
          taker: '0xinsider',
          marketId: 'token-no',
          side: 'Sell',
          size: '500000000',
          price: '0.90',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      // Should only have YES trade, NO filtered as complementary
      expect(result).toHaveLength(1);
      expect(result[0].outcome).toBe('YES');
      expect(result[0].totalValueUsd).toBe(5000);
      expect(result[0].hadComplementaryFills).toBe(true);
      expect(result[0].complementaryValueUsd).toBe(500);
    });

    it('uses position to determine complementary when wallet has YES position', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '1000000000', // $1000 YES
          price: '0.10',
        },
        {
          id: '0xtx1-1',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker2',
          taker: '0xinsider',
          marketId: 'token-no',
          side: 'Sell',
          size: '5000000000', // $5000 NO (larger, but complementary due to position)
          price: '0.90',
        },
      ];

      const optionsWithPosition = {
        ...baseOptions,
        walletPositions: [
          {
            id: 'pos1',
            marketId: 'token-yes',
            valueBought: '10000000000',
            valueSold: '0',
            netValue: '10000000000',
            quantityBought: '100000000000',
            quantitySold: '0',
            netQuantity: '100000000000', // Has YES position
          },
        ],
      };

      const result = aggregateFills(fills, optionsWithPosition);

      // YES should be kept (matches position), NO filtered
      expect(result).toHaveLength(1);
      expect(result[0].outcome).toBe('YES');
      expect(result[0].hadComplementaryFills).toBe(true);
      expect(result[0].complementaryValueUsd).toBe(5000);
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/aggregator.test.ts`
Expected: FAIL (complementary logic not implemented)

**Step 3: Update implementation with complementary detection**

Replace `src/api/aggregator.ts` with:

```typescript
import type { SubgraphTrade, SubgraphPosition, AggregatedTrade, TradeFill } from './types.js';

export interface AggregationOptions {
  wallet: string;
  tokenToOutcome: Map<string, 'YES' | 'NO'>;
  walletPositions?: SubgraphPosition[];
}

interface FillGroup {
  txHash: string;
  outcome: 'YES' | 'NO';
  fills: SubgraphTrade[];
  totalValueUsd: number;
}

export function aggregateFills(
  fills: SubgraphTrade[],
  options: AggregationOptions
): AggregatedTrade[] {
  const { wallet, tokenToOutcome, walletPositions = [] } = options;
  const walletLower = wallet.toLowerCase();

  // Step 1: Group fills by transactionHash + outcome
  const groups = new Map<string, FillGroup>();

  for (const fill of fills) {
    const txHash = fill.transactionHash;
    const outcome = tokenToOutcome.get(fill.marketId.toLowerCase()) ?? 'YES';
    const key = `${txHash}|${outcome}`;
    const valueUsd = parseFloat(fill.size) / 1e6;

    if (!groups.has(key)) {
      groups.set(key, { txHash, outcome, fills: [], totalValueUsd: 0 });
    }
    const group = groups.get(key)!;
    group.fills.push(fill);
    group.totalValueUsd += valueUsd;
  }

  // Step 2: Detect complementary trades per transaction
  // Group by txHash to find txs with both YES and NO
  const txToGroups = new Map<string, FillGroup[]>();
  for (const group of groups.values()) {
    if (!txToGroups.has(group.txHash)) {
      txToGroups.set(group.txHash, []);
    }
    txToGroups.get(group.txHash)!.push(group);
  }

  // Determine wallet positions for YES/NO tokens
  const hasYesPosition = walletPositions.some(p => {
    const outcome = tokenToOutcome.get(p.marketId.toLowerCase());
    return outcome === 'YES' && parseFloat(p.netQuantity) > 0;
  });
  const hasNoPosition = walletPositions.some(p => {
    const outcome = tokenToOutcome.get(p.marketId.toLowerCase());
    return outcome === 'NO' && parseFloat(p.netQuantity) > 0;
  });

  // Step 3: Build result, filtering complementary
  const result: AggregatedTrade[] = [];

  for (const [txHash, txGroups] of txToGroups) {
    let complementaryOutcome: 'YES' | 'NO' | null = null;
    let complementaryValueUsd = 0;

    // Check if tx has both YES and NO
    if (txGroups.length === 2) {
      const yesGroup = txGroups.find(g => g.outcome === 'YES');
      const noGroup = txGroups.find(g => g.outcome === 'NO');

      if (yesGroup && noGroup) {
        // Determine which is complementary
        if (hasYesPosition && !hasNoPosition) {
          complementaryOutcome = 'NO';
          complementaryValueUsd = noGroup.totalValueUsd;
        } else if (hasNoPosition && !hasYesPosition) {
          complementaryOutcome = 'YES';
          complementaryValueUsd = yesGroup.totalValueUsd;
        } else {
          // Fall back to smaller value
          if (yesGroup.totalValueUsd <= noGroup.totalValueUsd) {
            complementaryOutcome = 'YES';
            complementaryValueUsd = yesGroup.totalValueUsd;
          } else {
            complementaryOutcome = 'NO';
            complementaryValueUsd = noGroup.totalValueUsd;
          }
        }
      }
    }

    // Convert non-complementary groups to AggregatedTrade
    for (const group of txGroups) {
      if (group.outcome === complementaryOutcome) {
        continue; // Skip complementary
      }

      const firstFill = group.fills[0];
      const isMaker = firstFill.maker.toLowerCase() === walletLower;
      const role: 'maker' | 'taker' = isMaker ? 'maker' : 'taker';
      const side: 'BUY' | 'SELL' = isMaker
        ? (firstFill.side === 'Buy' ? 'BUY' : 'SELL')
        : (firstFill.side === 'Buy' ? 'SELL' : 'BUY');

      let totalValueUsd = 0;
      let totalSize = 0;
      let earliestTimestamp = Infinity;
      const tradeFills: TradeFill[] = [];

      for (const fill of group.fills) {
        const valueUsd = parseFloat(fill.size) / 1e6;
        const price = parseFloat(fill.price);
        const size = price > 0 ? valueUsd / price : 0;

        totalValueUsd += valueUsd;
        totalSize += size;
        earliestTimestamp = Math.min(earliestTimestamp, fill.timestamp);

        tradeFills.push({
          id: fill.id,
          size,
          price,
          valueUsd,
          timestamp: fill.timestamp,
          maker: fill.maker,
          taker: fill.taker,
          role,
        });
      }

      const avgPrice = totalSize > 0 ? totalValueUsd / totalSize : 0;

      result.push({
        transactionHash: txHash,
        marketId: firstFill.marketId,
        wallet: walletLower,
        side,
        outcome: group.outcome,
        totalSize,
        totalValueUsd,
        avgPrice,
        timestamp: new Date(earliestTimestamp * 1000),
        fills: tradeFills,
        fillCount: tradeFills.length,
        hadComplementaryFills: complementaryOutcome !== null,
        complementaryValueUsd: complementaryOutcome !== null ? complementaryValueUsd : undefined,
      });
    }
  }

  // Sort by timestamp descending
  result.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/aggregator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/aggregator.ts tests/api/aggregator.test.ts
git commit -m "feat: add complementary trade detection to aggregator"
```

---

## Task 5: Add Edge Case Tests

**Files:**
- Modify: `tests/api/aggregator.test.ts`

**Step 1: Add edge case tests**

Add to `tests/api/aggregator.test.ts`:

```typescript
  describe('edge cases', () => {
    it('handles single-fill transactions', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '1000000000',
          price: '0.10',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      expect(result).toHaveLength(1);
      expect(result[0].fillCount).toBe(1);
      expect(result[0].fills).toHaveLength(1);
    });

    it('handles empty input', () => {
      const result = aggregateFills([], baseOptions);
      expect(result).toHaveLength(0);
    });

    it('handles multiple separate transactions', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '1000000000',
          price: '0.10',
        },
        {
          id: '0xtx2-0',
          transactionHash: '0xtx2',
          timestamp: 2000,
          maker: '0xmaker1',
          taker: '0xinsider',
          marketId: 'token-yes',
          side: 'Sell',
          size: '2000000000',
          price: '0.20',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      expect(result).toHaveLength(2);
      // Should be sorted by timestamp desc
      expect(result[0].transactionHash).toBe('0xtx2');
      expect(result[1].transactionHash).toBe('0xtx1');
    });

    it('correctly determines maker vs taker role', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xinsider', // Wallet is maker
          taker: '0xother',
          marketId: 'token-yes',
          side: 'Sell', // Maker sells
          size: '1000000000',
          price: '0.10',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      expect(result[0].side).toBe('SELL'); // Maker's side matches
      expect(result[0].fills[0].role).toBe('maker');
    });

    it('inverts side for taker', () => {
      const fills: SubgraphTrade[] = [
        {
          id: '0xtx1-0',
          transactionHash: '0xtx1',
          timestamp: 1000,
          maker: '0xother',
          taker: '0xinsider', // Wallet is taker
          marketId: 'token-yes',
          side: 'Sell', // Maker sells, so taker BUYS
          size: '1000000000',
          price: '0.10',
        },
      ];

      const result = aggregateFills(fills, baseOptions);

      expect(result[0].side).toBe('BUY'); // Taker's side is opposite
      expect(result[0].fills[0].role).toBe('taker');
    });
  });
```

**Step 2: Run tests**

Run: `npx vitest run tests/api/aggregator.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/api/aggregator.test.ts
git commit -m "test: add edge case tests for aggregator"
```

---

## Task 6: Update Signal Types

**Files:**
- Modify: `src/signals/types.ts`

**Step 1: Update the Signal interface and Trade type**

Replace `src/signals/types.ts` with:

```typescript
import type { AggregatedTrade } from '../api/types.js';

export interface SignalResult {
  name: string;
  score: number; // 0-100
  weight: number; // percentage weight in final score
  details: Record<string, unknown>;
}

export interface AggregatedScore {
  total: number; // 0-100 weighted sum
  signals: SignalResult[];
  isAlert: boolean;
}

export interface Signal {
  name: string;
  weight: number;
  calculate(trade: AggregatedTrade, context: SignalContext): Promise<SignalResult>;
}

export interface SignalContext {
  config: import('../config.js').Config;
  accountHistory?: AccountHistory;
  marketPrices?: PricePoint[];
}

// Re-export AggregatedTrade as Trade for backward compatibility during migration
// TODO: Remove this alias after all consumers are updated
export type Trade = AggregatedTrade;

export interface AccountHistory {
  wallet: string;
  totalTrades: number;
  firstTradeDate: Date | null;
  lastTradeDate: Date | null;
  totalVolumeUsd: number;
  // Enhanced fields from subgraph (optional for backward compatibility)
  creationDate?: Date; // True account creation from blockchain
  profitUsd?: number; // Lifetime P&L (trading + redemptions)
  tradingProfitUsd?: number; // valueSold - valueBought (before redemptions)
  redemptionPayoutsUsd?: number; // Total payouts from resolved winning positions
  dataSource?: 'data-api' | 'subgraph' | 'subgraph-trades' | 'subgraph-estimated' | 'cache';
}

export interface PricePoint {
  timestamp: Date;
  price: number;
}
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: FAIL (signals use old field names)

**Step 3: Commit partial progress**

```bash
git add src/signals/types.ts
git commit -m "refactor: update Signal interface to use AggregatedTrade"
```

---

## Task 7: Update TradeSizeSignal

**Files:**
- Modify: `src/signals/tradeSize.ts`
- Modify: `tests/signals/tradeSize.test.ts`

**Step 1: Update signal implementation**

Replace `src/signals/tradeSize.ts`:

```typescript
import type { Signal, SignalResult, SignalContext, PricePoint } from './types.js';
import type { AggregatedTrade } from '../api/types.js';

export class TradeSizeSignal implements Signal {
  name = 'tradeSize';
  weight = 40;

  async calculate(trade: AggregatedTrade, context: SignalContext): Promise<SignalResult> {
    const { config, marketPrices = [] } = context;
    const { minAbsoluteUsd, minImpactPercent, impactWindowMinutes } = config.tradeSize;

    // Check minimum threshold
    if (trade.totalValueUsd < minAbsoluteUsd) {
      return {
        name: this.name,
        score: 0,
        weight: this.weight,
        details: { reason: 'below_threshold', valueUsd: trade.totalValueUsd, minAbsoluteUsd },
      };
    }

    // Calculate size score (0-50 points) - scales logarithmically
    const sizeMultiple = trade.totalValueUsd / minAbsoluteUsd;
    const sizeScore = Math.min(50, Math.log10(sizeMultiple) * 25 + 25);

    // Calculate impact score (0-50 points)
    const impact = this.calculateImpact(trade, marketPrices, impactWindowMinutes);
    const impactScore = impact >= minImpactPercent
      ? Math.min(50, (impact / minImpactPercent) * 25)
      : 0;

    const totalScore = Math.round(sizeScore + impactScore);

    return {
      name: this.name,
      score: Math.min(100, totalScore),
      weight: this.weight,
      details: {
        valueUsd: trade.totalValueUsd,
        sizeScore: Math.round(sizeScore),
        impactPercent: impact,
        impactScore: Math.round(impactScore),
        fillCount: trade.fillCount,
      },
    };
  }

  private calculateImpact(
    trade: AggregatedTrade,
    prices: PricePoint[],
    windowMinutes: number
  ): number {
    if (prices.length < 2) return 0;

    const tradeTime = trade.timestamp.getTime();
    const windowMs = windowMinutes * 60 * 1000;

    const before = prices
      .filter(p => p.timestamp.getTime() < tradeTime &&
                   p.timestamp.getTime() > tradeTime - windowMs)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

    const after = prices
      .filter(p => p.timestamp.getTime() > tradeTime &&
                   p.timestamp.getTime() < tradeTime + windowMs)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];

    if (!before || !after) return 0;

    const priceDiff = Math.abs(after.price - before.price);
    return (priceDiff / before.price) * 100;
  }
}
```

**Step 2: Update test fixtures**

Replace `tests/signals/tradeSize.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TradeSizeSignal } from '../../src/signals/tradeSize.js';
import type { AggregatedTrade } from '../../src/api/types.js';
import type { SignalContext } from '../../src/signals/types.js';
import { loadConfig } from '../../src/config.js';

describe('TradeSizeSignal', () => {
  const signal = new TradeSizeSignal();
  const config = loadConfig();

  const makeTrade = (valueUsd: number): AggregatedTrade => ({
    transactionHash: '0xtx1',
    marketId: 'market1',
    wallet: '0xwallet',
    side: 'BUY',
    outcome: 'YES',
    totalSize: valueUsd / 0.5, // Assume 50 cent price
    totalValueUsd: valueUsd,
    avgPrice: 0.5,
    timestamp: new Date(),
    fills: [{
      id: '0xtx1-0',
      size: valueUsd / 0.5,
      price: 0.5,
      valueUsd,
      timestamp: Date.now() / 1000,
    }],
    fillCount: 1,
  });

  const baseContext: SignalContext = { config };

  it('returns 0 for trades below threshold', async () => {
    const trade = makeTrade(100); // Below $5000 default
    const result = await signal.calculate(trade, baseContext);
    expect(result.score).toBe(0);
    expect(result.details.reason).toBe('below_threshold');
  });

  it('scores trades at threshold as 25', async () => {
    const trade = makeTrade(5000); // Exactly at threshold
    const result = await signal.calculate(trade, baseContext);
    expect(result.score).toBe(25); // log10(1) * 25 + 25 = 25
  });

  it('scores large trades higher', async () => {
    const trade = makeTrade(50000); // 10x threshold
    const result = await signal.calculate(trade, baseContext);
    expect(result.score).toBe(50); // log10(10) * 25 + 25 = 50
  });

  it('caps score at 100', async () => {
    const trade = makeTrade(5000000); // 1000x threshold
    const result = await signal.calculate(trade, baseContext);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run tests/signals/tradeSize.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/signals/tradeSize.ts tests/signals/tradeSize.test.ts
git commit -m "refactor: update TradeSizeSignal to use AggregatedTrade"
```

---

## Task 8: Update ConvictionSignal

**Files:**
- Modify: `src/signals/conviction.ts`
- Modify: `tests/signals/conviction.test.ts`

**Step 1: Read current conviction signal**

Run: `cat src/signals/conviction.ts`

**Step 2: Update signal implementation**

Update `src/signals/conviction.ts` to use `trade.totalValueUsd` instead of `trade.valueUsd`:

```typescript
import type { Signal, SignalResult, SignalContext } from './types.js';
import type { AggregatedTrade } from '../api/types.js';

export class ConvictionSignal implements Signal {
  name = 'conviction';
  weight = 25;

  async calculate(trade: AggregatedTrade, context: SignalContext): Promise<SignalResult> {
    const { accountHistory } = context;

    // If no account history, can't calculate conviction
    if (!accountHistory || accountHistory.totalVolumeUsd === 0) {
      // New wallet with no history - high conviction by default
      return {
        name: this.name,
        score: 80,
        weight: this.weight,
        details: {
          reason: 'no_history',
          tradeValueUsd: trade.totalValueUsd,
        },
      };
    }

    // Calculate what percentage of their total volume this trade represents
    const concentration = (trade.totalValueUsd / accountHistory.totalVolumeUsd) * 100;

    // Score based on concentration
    // 50%+ of volume in one trade = max score
    // 10% = medium score
    // <5% = low score
    let score: number;
    if (concentration >= 50) {
      score = 100;
    } else if (concentration >= 25) {
      score = 70 + (concentration - 25) * 1.2; // 70-100
    } else if (concentration >= 10) {
      score = 40 + (concentration - 10) * 2; // 40-70
    } else if (concentration >= 5) {
      score = 20 + (concentration - 5) * 4; // 20-40
    } else {
      score = concentration * 4; // 0-20
    }

    return {
      name: this.name,
      score: Math.round(Math.min(100, score)),
      weight: this.weight,
      details: {
        tradeValueUsd: trade.totalValueUsd,
        totalVolumeUsd: accountHistory.totalVolumeUsd,
        concentrationPercent: Math.round(concentration * 10) / 10,
      },
    };
  }
}
```

**Step 3: Update test fixtures**

Update `tests/signals/conviction.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ConvictionSignal } from '../../src/signals/conviction.js';
import type { AggregatedTrade } from '../../src/api/types.js';
import type { SignalContext, AccountHistory } from '../../src/signals/types.js';
import { loadConfig } from '../../src/config.js';

describe('ConvictionSignal', () => {
  const signal = new ConvictionSignal();
  const config = loadConfig();

  const makeTrade = (valueUsd: number): AggregatedTrade => ({
    transactionHash: '0xtx1',
    marketId: 'market1',
    wallet: '0xwallet',
    side: 'BUY',
    outcome: 'YES',
    totalSize: valueUsd / 0.5,
    totalValueUsd: valueUsd,
    avgPrice: 0.5,
    timestamp: new Date(),
    fills: [{
      id: '0xtx1-0',
      size: valueUsd / 0.5,
      price: 0.5,
      valueUsd,
      timestamp: Date.now() / 1000,
    }],
    fillCount: 1,
  });

  const makeHistory = (totalVolumeUsd: number): AccountHistory => ({
    wallet: '0xwallet',
    totalTrades: 10,
    firstTradeDate: new Date('2024-01-01'),
    lastTradeDate: new Date(),
    totalVolumeUsd,
  });

  it('returns high score for new wallets with no history', async () => {
    const trade = makeTrade(10000);
    const context: SignalContext = { config };

    const result = await signal.calculate(trade, context);
    expect(result.score).toBe(80);
    expect(result.details.reason).toBe('no_history');
  });

  it('returns max score for 50%+ concentration', async () => {
    const trade = makeTrade(10000);
    const context: SignalContext = {
      config,
      accountHistory: makeHistory(15000), // 66% concentration
    };

    const result = await signal.calculate(trade, context);
    expect(result.score).toBe(100);
  });

  it('returns medium score for 10-25% concentration', async () => {
    const trade = makeTrade(10000);
    const context: SignalContext = {
      config,
      accountHistory: makeHistory(50000), // 20% concentration
    };

    const result = await signal.calculate(trade, context);
    expect(result.score).toBeGreaterThan(40);
    expect(result.score).toBeLessThan(70);
  });

  it('returns low score for <5% concentration', async () => {
    const trade = makeTrade(1000);
    const context: SignalContext = {
      config,
      accountHistory: makeHistory(100000), // 1% concentration
    };

    const result = await signal.calculate(trade, context);
    expect(result.score).toBeLessThan(20);
  });
});
```

**Step 4: Run tests**

Run: `npx vitest run tests/signals/conviction.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/signals/conviction.ts tests/signals/conviction.test.ts
git commit -m "refactor: update ConvictionSignal to use AggregatedTrade"
```

---

## Task 9: Update AccountHistorySignal

**Files:**
- Modify: `src/signals/accountHistory.ts`
- Modify: `tests/signals/accountHistory.test.ts`

**Step 1: Update signal (minimal changes - just type import)**

The AccountHistorySignal primarily uses `context.accountHistory`, not trade fields. Update the import and type annotation:

In `src/signals/accountHistory.ts`, update the import:

```typescript
import type { Signal, SignalResult, SignalContext } from './types.js';
import type { AggregatedTrade } from '../api/types.js';
```

And update the method signature:

```typescript
async calculate(trade: AggregatedTrade, context: SignalContext): Promise<SignalResult> {
```

**Step 2: Update test fixtures**

Update `tests/signals/accountHistory.test.ts` to use `AggregatedTrade` type for trade fixtures. The tests mostly focus on `accountHistory` in context, so changes are minimal - just update the `makeTrade` helper.

**Step 3: Run tests**

Run: `npx vitest run tests/signals/accountHistory.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/signals/accountHistory.ts tests/signals/accountHistory.test.ts
git commit -m "refactor: update AccountHistorySignal to use AggregatedTrade"
```

---

## Task 10: Update Output Types

**Files:**
- Modify: `src/output/types.ts`

**Step 1: Update SuspiciousTrade type**

Update `src/output/types.ts`:

```typescript
import type { AggregatedTrade } from '../api/types.js';
import type { AggregatedScore, AccountHistory } from '../signals/types.js';
import type { Market } from '../api/types.js';

export interface SuspiciousTrade {
  trade: AggregatedTrade;
  score: AggregatedScore;
  accountHistory?: AccountHistory;
  priceImpact?: {
    before: number;
    after: number;
    changePercent: number;
  };
  classifications?: string[];
}

export interface AnalysisReport {
  market: Market;
  totalTrades: number;
  analyzedTrades: number;
  suspiciousTrades: SuspiciousTrade[];
  analyzedAt: Date;
  targetWallet?: string;
  targetAccountHistory?: AccountHistory;
}
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: Errors in cli.ts and commands (field name mismatches)

**Step 3: Commit partial progress**

```bash
git add src/output/types.ts
git commit -m "refactor: update output types to use AggregatedTrade"
```

---

## Task 11: Update CLI Output

**Files:**
- Modify: `src/output/cli.ts`

**Step 1: Update field references**

In `src/output/cli.ts`, update all references:
- `trade.valueUsd` → `trade.totalValueUsd`
- `trade.size` → `trade.totalSize`
- `trade.price` → `trade.avgPrice`
- Add `trade.fillCount` display where relevant

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: Fewer errors (commands still need updating)

**Step 3: Commit**

```bash
git add src/output/cli.ts
git commit -m "refactor: update CLI output to use AggregatedTrade fields"
```

---

## Task 12: Update Analyze Command

**Files:**
- Modify: `src/commands/analyze.ts`

**Step 1: Replace inline aggregation with aggregateFills()**

This is the largest change. The wallet-mode section (lines ~83-222) gets replaced with a call to `aggregateFills()`.

Key changes:
1. Import `aggregateFills` from `../api/aggregator.js`
2. Remove inline `txMap`, `txGroups`, `complementaryIds` logic
3. Call `aggregateFills()` after fetching trades
4. Update field references in the rest of the file

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (or close to it)

**Step 3: Run tests**

Run: `npx vitest run tests/commands/analyze.test.ts`
Expected: May need fixture updates

**Step 4: Commit**

```bash
git add src/commands/analyze.ts
git commit -m "refactor: use aggregateFills() in analyze command"
```

---

## Task 13: Update Investigate Command

**Files:**
- Modify: `src/commands/investigate.ts`

**Step 1: Replace convertToTrade with aggregateFills()**

Similar to analyze command:
1. Import `aggregateFills`
2. Call it on `recentTrades` before processing
3. Update the suspicious trade analysis loop to use aggregated trades
4. Remove the `convertToTrade` private method

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/commands/investigate.ts
git commit -m "refactor: use aggregateFills() in investigate command"
```

---

## Task 14: Update Remaining Tests

**Files:**
- Modify: `tests/commands/analyze.test.ts`
- Modify: `tests/integration/analyze.test.ts`
- Modify: `tests/output/cli.test.ts`

**Step 1: Update test fixtures to AggregatedTrade shape**

Each test file that creates Trade objects needs updating to use the new shape with `totalValueUsd`, `totalSize`, `avgPrice`, `fills`, `fillCount`.

**Step 2: Run full test suite**

Run: `npm run test:run`
Expected: All tests pass

**Step 3: Commit**

```bash
git add tests/
git commit -m "test: update all test fixtures for AggregatedTrade"
```

---

## Task 15: Final Verification

**Step 1: Run full test suite**

Run: `npm run test:run`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Manual test with real data**

Run: `npm run dev -- investigate -w 0x31a56e9E690c621eD21De08Cb559e9524Cdb8eD9 -m 0x580adc1327de9bf7c179ef5aaffa3377bb5cb252b7d6390b027172d43fd6f993`

Expected: Should show ~7 transactions instead of ~46 fills

**Step 4: Update PROJECT_STATUS.md**

Add entry for aggregate trades implementation.

**Step 5: Final commit**

```bash
git add PROJECT_STATUS.md
git commit -m "docs: update PROJECT_STATUS for aggregate trades"
```

---

## Summary

| Task | Description | Est. Complexity |
|------|-------------|-----------------|
| 1 | Add new types | Low |
| 2 | Create aggregator with basic test | Medium |
| 3 | Add price calculation test | Low |
| 4 | Add complementary detection | Medium |
| 5 | Add edge case tests | Low |
| 6 | Update signal types | Low |
| 7 | Update TradeSizeSignal | Low |
| 8 | Update ConvictionSignal | Low |
| 9 | Update AccountHistorySignal | Low |
| 10 | Update output types | Low |
| 11 | Update CLI output | Medium |
| 12 | Update analyze command | High |
| 13 | Update investigate command | Medium |
| 14 | Update remaining tests | Medium |
| 15 | Final verification | Low |

Total: ~15 tasks, each 2-15 minutes
