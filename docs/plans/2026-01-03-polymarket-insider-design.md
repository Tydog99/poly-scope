# Polymarket Insider Trading Detector

## Overview

A TypeScript CLI tool that detects potential insider trading on Polymarket by scoring trades based on size/impact, account history, and directional conviction. Supports both forensic analysis of historical markets and real-time monitoring.

## Goals

- Identify suspicious trading patterns that may indicate insider information
- Start with forensic analysis to validate detection logic on known cases
- Progress to real-time monitoring with trade recommendations
- All thresholds and weights easily configurable

## Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────────┐
│                        Data Layer                           │
├─────────────────┬─────────────────┬─────────────────────────┤
│ Polymarket      │ Trade Fetcher   │ Account Analyzer        │
│ Client          │ (REST + WS)     │ (history scoring)       │
└────────┬────────┴────────┬────────┴────────────┬────────────┘
         │                 │                     │
         ▼                 ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                     Detection Engine                         │
├─────────────────┬─────────────────┬─────────────────────────┤
│ TradeSizeSignal │ AccountHistory  │ ConvictionSignal        │
│ (40%)           │ Signal (35%)    │ (25%)                   │
└────────┬────────┴────────┬────────┴────────────┬────────────┘
         │                 │                     │
         ▼                 ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    Signal Aggregator                         │
│              (weighted sum → 0-100 score)                   │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       Output Layer                           │
├─────────────────┬─────────────────┬─────────────────────────┤
│ CLI Reporter    │ Web API (later) │ Notifier (later)        │
└─────────────────┴─────────────────┴─────────────────────────┘
```

### Detection Signals

#### Trade Size Signal (weight: 40%)

Measures trade significance by combining absolute size and market impact.

**Metrics:**
- Absolute size: trade value in USD (size × price)
- Market impact: price change within 5-minute window around trade

**Thresholds (configurable):**
- Minimum absolute size: $5,000
- Minimum impact: 2% price movement

Score scales linearly — larger trades with bigger impact score higher.

#### Account History Signal (weight: 35%)

Identifies new, dormant, or low-activity accounts.

**Metrics:**
- Trade count: total lifetime trades on Polymarket
- Account age: days since first trade
- Dormancy: days since last trade before the suspicious one

**Thresholds (configurable):**
- Suspicious if: <10 lifetime trades OR <30 days old OR >60 days dormant

#### Conviction Signal (weight: 25%)

Detects one-sided, high-conviction bets.

**Metrics:**
- Position concentration: percentage bet on one outcome vs. hedging
- Portfolio exposure: how much of their capital is in this single bet

**Thresholds (configurable):**
- High conviction: 80%+ on one outcome

### Aggregation

Weighted sum produces a 0-100 "insider likelihood" score. Trades scoring above threshold (default: 70) trigger alerts.

## Configuration

All tunable parameters in `config.json`:

```json
{
  "weights": {
    "tradeSize": 40,
    "accountHistory": 35,
    "conviction": 25
  },
  "tradeSize": {
    "minAbsoluteUsd": 5000,
    "minImpactPercent": 2,
    "impactWindowMinutes": 5
  },
  "accountHistory": {
    "maxLifetimeTrades": 10,
    "maxAccountAgeDays": 30,
    "minDormancyDays": 60
  },
  "conviction": {
    "minPositionPercent": 80
  },
  "alertThreshold": 70,
  "watchlist": []
}
```

CLI supports overrides: `--min-size 10000` for quick experimentation.

## Commands

### Forensic Analysis

```bash
# Analyze a specific market
polymarket-insider analyze --market <condition-id>

# With filters
polymarket-insider analyze --market <condition-id> \
  --after "2024-01-15" \
  --before "2024-01-17" \
  --outcome "Yes"
```

**Flow:**
1. Fetch market metadata (details, resolution time, final outcome)
2. Fetch all trades for the market
3. Filter to winning side only
4. Score each trade through detection engine
5. Enrich high-scoring trades with full account history
6. Output ranked list of suspicious trades

**Output:**
```
Market: "Will US bomb Venezuela by Feb 2025?" → Resolved YES

Top Suspicious Trades:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#1  Score: 94/100
    Wallet: 0x1a2b...3c4d
    Trade: $47,000 YES @ 0.12 → moved price to 0.19 (+58%)
    Account: 3 lifetime trades, created 2 days before trade

#2  Score: 87/100
    ...
```

### Real-Time Monitoring

```bash
# Monitor specific markets
polymarket-insider monitor --market <id1> --market <id2>

# Monitor all markets above volume threshold
polymarket-insider monitor --min-volume 100000

# Background mode
polymarket-insider monitor --market <id> --daemon
```

**Flow:**
1. Connect to WebSocket at `wss://ws-subscriptions-clob.polymarket.com`
2. Filter trades to watched markets
3. Quick-score each trade
4. Async fetch account history for promising scores
5. Final scoring with all signals
6. Alert if above threshold

**Output:**
```
🚨 INSIDER SIGNAL DETECTED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Market: "Will X happen by Y date?"
Score: 89/100

Detected Trade:
  Wallet: 0x1a2b...3c4d (new account, 4 trades)
  Action: BUY YES @ 0.23 for $32,000
  Impact: Price moved 0.19 → 0.27 (+42%)

Recommendation:
  Action: BUY YES
  Current price: 0.27
  Suggested size: $500 (your configured max)
```

## Project Structure

```
polymarket-insider/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── config.ts             # Configuration loading & defaults
│   │
│   ├── api/
│   │   ├── client.ts         # Polymarket API wrapper
│   │   ├── trades.ts         # Trade fetching (REST)
│   │   ├── stream.ts         # WebSocket subscription
│   │   └── accounts.ts       # Account history fetching
│   │
│   ├── signals/
│   │   ├── types.ts          # Signal interfaces
│   │   ├── tradeSize.ts      # Trade size + impact signal
│   │   ├── accountHistory.ts # Account newness/dormancy signal
│   │   ├── conviction.ts     # Directional conviction signal
│   │   └── aggregator.ts     # Weighted score combination
│   │
│   ├── commands/
│   │   ├── analyze.ts        # Forensic analysis command
│   │   └── monitor.ts        # Real-time monitoring command
│   │
│   └── output/
│       ├── cli.ts            # Terminal formatting & colors
│       └── types.ts          # Output interfaces
│
├── tests/
│   ├── signals/              # Unit tests for each signal
│   ├── api/                  # API client tests (mocked)
│   ├── commands/             # Integration tests for CLI commands
│   └── fixtures/             # Test data from real markets
│
├── config.json               # User configuration
├── package.json
└── tsconfig.json
```

## Dependencies

- `@polymarket/clob-client` — official Polymarket SDK
- `commander` — CLI argument parsing
- `ws` — WebSocket client
- `chalk` — terminal colors

**Dev dependencies:**
- `vitest` — test runner
- `typescript` — type checking
- `tsx` — TypeScript execution

## Testing Strategy

Thorough tests at multiple levels:

### Unit Tests
- Each signal calculator tested in isolation
- Edge cases: zero trades, dormant accounts, small/large impacts
- Aggregator tested with various weight configurations

### Integration Tests
- Full forensic analysis flow with mocked API responses
- WebSocket monitoring with simulated trade streams
- Configuration loading and CLI argument parsing

### Fixtures
- Capture real trade data from known insider cases (e.g., Venezuela market)
- Use as regression tests to ensure detection logic catches known insiders

## Implementation Phases

### Phase 1: Forensic Analysis (MVP)
- Project setup, TypeScript config, dependencies
- API client for fetching trades and account history
- All three signal calculators
- Aggregator with configurable weights
- `analyze` command with CLI output
- Comprehensive test suite

### Phase 2: Real-Time Monitoring
- WebSocket client for live trades
- `monitor` command with watchlist support
- Trade recommendations in output

### Phase 3: Web Dashboard
- React frontend for live alerts
- Configuration UI
- Trade history tracking

### Phase 4: Notifications + Semi-Automation
- Discord/Telegram integrations
- One-click trade execution
