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

## Architecture

The detection pipeline:

1. **Data Layer** (`src/api/`) - Fetches market data and trades via Polymarket APIs
   - `client.ts` - Wraps `@polymarket/clob-client` SDK
   - `trades.ts` - Fetches trade history for a market
   - `accounts.ts` - Fetches account trading history
   - `slug.ts` - Resolves market slugs to condition IDs via Gamma API

2. **Detection Engine** (`src/signals/`) - Three weighted signals produce 0-100 scores:
   - `TradeSizeSignal` (40%) - Absolute size and market impact
   - `AccountHistorySignal` (35%) - Account newness, low trade count, dormancy
   - `ConvictionSignal` (25%) - One-sided, high-conviction bets
   - `SignalAggregator` - Combines weighted signals, flags trades above threshold

3. **Commands** (`src/commands/`) - CLI command implementations
   - `analyze.ts` - Forensic analysis of historical markets

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
