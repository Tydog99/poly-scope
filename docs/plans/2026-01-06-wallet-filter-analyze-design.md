# Design: Wallet Filter for Analyze Command

**Date:** 2026-01-06

## Summary

Add a `-w, --wallet <address>` flag to the `analyze` command that filters trades to a specific wallet and provides verbose scoring output.

## CLI Interface

```bash
./dist/index.js analyze --market venezuela -w 0x1234...
```

**Flag behavior:**
- `-w, --wallet <address>` - Filter to a specific wallet's trades
- When `-w` is provided:
  - Ignores `--min-size` (shows all trades regardless of size)
  - Ignores `--top` limit (shows all trades, not just top N)
  - Still respects `--before`, `--after`, `--outcome`, `--role` filters

**Incompatibilities:**
- `-w` with `--all` (multi-market mode) - errors with clear message

## Output Format

### Part A: Account Header

```
═══════════════════════════════════════════════════════════════
Wallet Analysis: 0x1234...abcd on "Will Maduro win Venezuela?"
═══════════════════════════════════════════════════════════════

Account Stats:
  Created:      2024-03-15 (287 days ago)
  Total Trades: 12
  Volume:       $45,230
  Profit:       $8,450 (18.7% ROI)
```

### Part B: Trades Summary Table

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ #  │ Time       │ Side     │ Size      │ Price │ Score │ Breakdown         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1  │ 2024-11-02 │ BUY YES  │ $12,500   │ 0.08  │ 78    │ Sz:82 Ac:71 Cv:80 │
│ 2  │ 2024-11-01 │ BUY YES  │ $5,200    │ 0.12  │ 65    │ Sz:58 Ac:71 Cv:68 │
│ 3  │ 2024-10-28 │ SELL NO  │ $800      │ 0.91  │ 42    │ Sz:25 Ac:71 Cv:35 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Part C: Detailed Breakdowns (one per trade)

```
Trade #1: BUY YES $12,500 @ 0.08 (2024-11-02 14:32:15)
──────────────────────────────────────────────────────
  Trade Size Signal (40% weight)         Score: 82
    • Absolute size: $12,500 → 75 pts
    • Market impact: 3.2% price move → 89 pts

  Account History Signal (35% weight)    Score: 71
    • Trade count: 12 → 45 pts
    • Account age: 287 days → 20 pts
    • Dormancy: 0 days idle → 0 pts
    • Profit on new account: N/A (not new)

  Conviction Signal (25% weight)         Score: 80
    • Trade concentration: 27.6% of volume → 80 pts

  FINAL SCORE: 78 ⚠️ ALERT
```

## Implementation

### Files to Modify

1. **`src/index.ts`**
   - Add `-w, --wallet <address>` option to analyze command
   - Pass wallet option to handler

2. **`src/commands/analyze.ts`**
   - Accept `wallet` option in AnalyzeOptions interface
   - When wallet provided:
     - Validate not used with `--all` flag
     - Skip min-size filtering
     - Query trades filtered to that wallet
     - Fetch account stats upfront
     - Run all trades through signal pipeline
     - Call new verbose output function

3. **`src/output/cli.ts`**
   - Add `printWalletAnalysis(wallet, account, trades, scores)` function
   - Renders three-part output: header, table, detailed breakdowns

### No Changes Needed

- Signal implementations (already return detailed breakdowns)
- Subgraph/API layer (already supports wallet filtering)
- Config system
