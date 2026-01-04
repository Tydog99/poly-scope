# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A TypeScript CLI tool that detects potential insider trading on Polymarket by scoring trades based on size/impact, account history, and directional conviction.

## Commands

```bash
npm run dev            # Run CLI in development mode (tsx)
npm run build          # Compile TypeScript to dist/
npm test               # Run tests in watch mode
npm run test:run       # Run tests once

# Run a single test file
npx vitest run tests/signals/tradeSize.test.ts

# CLI usage (after build)
./dist/index.js analyze --market <slug|conditionId>
```

## Sub Agents
Use sub agents to search the Web.

## Architecture

The detection pipeline:

1. **Data Layer** (`src/api/`) - Fetches market data and trades via Polymarket APIs
   - `client.ts` - Wraps `@polymarket/clob-client` SDK
   - `trades.ts` - Fetches trade history (subgraph primary, Data API fallback)
   - `accounts.ts` - Fetches account trading history
   - `subgraph.ts` - The Graph client for on-chain data
   - `slug.ts` - Resolves market slugs to condition IDs via Gamma API

2. **Detection Engine** (`src/signals/`) - Three weighted signals produce 0-100 scores:
   - `TradeSizeSignal` (40%) - Absolute size and market impact
   - `AccountHistorySignal` (35%) - Account newness, low trade count, dormancy
   - `ConvictionSignal` (25%) - One-sided, high-conviction bets
   - `SignalAggregator` - Combines weighted signals, flags trades above threshold

3. **Commands** (`src/commands/`) - CLI command implementations
   - `analyze.ts` - Forensic analysis of historical markets
   - `investigate.ts` - Deep-dive wallet investigation

4. **Output** (`src/output/`) - Formatting and display
   - `cli.ts` - Terminal output with chalk colors

## Configuration

`config.json` at project root controls signal weights and thresholds. Defaults in `src/config.ts`. CLI flags `--min-size` and `--threshold` override config values.

## Key Types

- `Trade` - Normalized trade with wallet, side, outcome, size, price, valueUsd
- `SignalResult` - Individual signal output (name, score 0-100, weight, details)
- `AggregatedScore` - Combined score with isAlert flag
- `AnalysisReport` - Full analysis output with market info and suspicious trades

## Testing

Tests mirror src structure in `tests/`. Integration tests in `tests/integration/` use fixtures from known insider trading cases.

## The Graph Subgraph

We use The Graph subgraph (`81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC`) as the primary data source for account history and trade data.

### Schema Reference

The official Polymarket subgraph schemas are at: https://github.com/Polymarket/polymarket-subgraph

Each subdirectory contains a `schema.graphql`:

| Subgraph | Key Entities | Useful For |
|----------|--------------|------------|
| `pnl-subgraph` | `UserPosition` (avgPrice, realizedPnl, totalBought) | Per-position P&L |
| `activity-subgraph` | `Split`, `Merge`, `Redemption`, `Position` | Token activity |
| `orderbook-subgraph` | `OrderFilledEvent`, `Orderbook` (per-token stats) | Trade events |
| `fpmm-subgraph` | `FpmmTransaction`, `FixedProductMarketMaker` | AMM trades |
| `wallet-subgraph` | `Wallet` (balance, createdAt, signer, type) | Wallet metadata |
| `oi-subgraph` | `MarketOpenInterest`, `GlobalOpenInterest` | Open interest |

### Deployed Subgraph Entities

The deployed subgraph we use has additional **enriched/aggregated entities** not in individual schemas:

- `Account` - Aggregated account stats (creationTimestamp, numTrades, collateralVolume, profit)
- `EnrichedOrderFilled` - Trade with maker/taker/market references
- `MarketPosition` - User positions per market

### Key Fields

```graphql
# Account (aggregated user stats)
account(id: $wallet) {
  id
  creationTimestamp
  lastSeenTimestamp
  collateralVolume    # 6 decimals
  numTrades
  profit              # 6 decimals, can be negative
  scaledProfit
}

# EnrichedOrderFilled (trades)
enrichedOrderFilleds(where: { market: $tokenId }) {
  id
  transactionHash
  timestamp
  maker { id }
  taker { id }
  market { id }       # Token/Orderbook ID
  side                # "Buy" or "Sell"
  size                # 6 decimals
  price               # 6 decimals
}

# MarketPosition (user holdings)
marketPositions(where: { user_: { id: $wallet } }) {
  market { id }
  valueBought
  valueSold
  netValue
  netQuantity
}
```

### Potentially Useful Fields Not Yet Used

- `UserPosition.avgPrice` - Average entry price per position
- `UserPosition.realizedPnl` - Realized P&L per position
- `Orderbook` - Per-token trade counts and volume aggregates
- `FpmmTransaction.outcomeIndex` - Maps trades to YES/NO outcomes
