# Real-Time Monitor Command Design

**Date:** 2026-01-07
**Status:** Approved

## Overview

A new `monitor` command that watches Polymarket markets in real-time via WebSocket and alerts when suspicious trades are detected. This enables proactive insider trading detection as it happens.

## Command Interface

```bash
# Basic usage - watch markets from config watchlist
polymarket monitor

# Watch specific markets (reuses -m flag)
polymarket monitor -m maduro-yes,bitcoin-100k

# Adjust settings
polymarket monitor --min-size 10000 --threshold 60

# Control retry behavior
polymarket monitor --max-reconnects 5 --retry-delay 300

# Verbose mode - show all evaluated trades
polymarket monitor --verbose
```

**CLI Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-m, --market <slugs>` | Comma-separated market slugs/IDs (adds to config watchlist) | from config |
| `--min-size <usd>` | Minimum trade size to evaluate | $5,000 |
| `--threshold <score>` | Alert threshold (0-100) | 70 |
| `--max-reconnects <n>` | Reconnect attempts before retry delay | 10 |
| `--retry-delay <seconds>` | Wait time after exhausting reconnects | 300 |
| `--verbose` | Show all evaluated trades, not just alerts | false |

## Architecture

### Data Source: RTDS WebSocket

Uses `@polymarket/real-time-data-client` library to subscribe to real-time trade events.

**Why RTDS over CLOB WebSocket:**

| Service | Trade Event | Has Wallet Address? |
|---------|-------------|---------------------|
| CLOB Market Channel | `last_trade_price` | No - only price/size/side |
| **RTDS Activity** | `activity/trades` | **Yes - has `proxyWallet`** |

We need wallet addresses to fetch account history for scoring.

**Trade event payload:**
```json
{
  "proxyWallet": "0x123...abc",
  "side": "BUY",
  "size": 10,
  "price": 0.75,
  "outcome": "Candidate A Wins",
  "outcomeIndex": 0,
  "conditionId": "market_cond_id",
  "slug": "election-2024-us",
  "timestamp": 1678886400,
  "transactionHash": "0xabc..."
}
```

### File Structure

```
src/
├── commands/
│   └── monitor.ts       # CLI command handler
├── monitor/
│   ├── stream.ts        # Wraps RealTimeDataClient with reconnect logic
│   ├── evaluator.ts     # Trade evaluation pipeline
│   └── types.ts         # Monitor-specific types
```

### Component Responsibilities

1. **`monitor.ts` (command)**
   - Entry point, resolves market slugs to token IDs
   - Orchestrates WebSocket + evaluator
   - Handles Ctrl+C gracefully

2. **`stream.ts` (connection manager)**
   - Wraps `RealTimeDataClient`
   - Subscribes to `activity/trades` topic filtered by market slugs
   - Handles reconnection with exponential backoff
   - After max reconnects: sleep for retry delay, reset counter, restart

3. **`evaluator.ts` (scoring pipeline)**
   - Receives trade events from stream
   - Quick filter: skip trades below `--min-size`
   - For qualifying trades: fetch account history, run all 3 signals
   - Emit alerts for trades scoring above threshold
   - Reuses existing signal classes

## Trade Evaluation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     WebSocket Trade Event                        │
│  { proxyWallet, side, size, price, outcome, slug, timestamp }   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ Size >= minSize? │
                    └─────────────────┘
                         │         │
                        No        Yes
                         │         │
                         ▼         ▼
                      [skip]   Fetch account
                               from subgraph
                                   │
                                   ▼
                         ┌─────────────────┐
                         │  Run 3 signals  │
                         │  (reuse existing)│
                         └─────────────────┘
                                   │
                                   ▼
                         ┌─────────────────┐
                         │ Score >= thresh?│
                         └─────────────────┘
                              │         │
                             No        Yes
                              │         │
                              ▼         ▼
                          [skip]    ALERT
```

**Trade normalization:**
```typescript
const trade: Trade = {
  id: event.transactionHash,
  wallet: event.proxyWallet,
  side: event.side as 'BUY' | 'SELL',
  outcome: event.outcomeIndex === 0 ? 'Yes' : 'No',
  size: event.size,
  price: event.price,
  valueUsd: event.size * event.price,
  timestamp: event.timestamp
};
```

## Reconnection & Error Handling

```
┌─────────────────────────────────────────────────────────────────┐
│                    Connection State Machine                      │
└─────────────────────────────────────────────────────────────────┘

     ┌──────────┐
     │  START   │
     └────┬─────┘
          │
          ▼
   ┌─────────────┐      success      ┌─────────────┐
   │ CONNECTING  │─────────────────▶│  CONNECTED  │◀─────┐
   └─────────────┘                   └──────┬──────┘      │
          │                                 │             │
          │ error                     disconnect          │
          ▼                                 │             │
   ┌─────────────┐                          ▼             │
   │  BACKOFF    │◀──────────────────┌─────────────┐     │
   │  (wait)     │                   │RECONNECTING │─────┘
   └──────┬──────┘                   └──────┬──────┘  success
          │                                 │
          │ attempts < max                  │ attempts >= max
          ▼                                 ▼
   ┌─────────────┐                   ┌─────────────┐
   │   RETRY     │                   │ RETRY_WAIT  │
   │ (reconnect) │                   │ (5 min...)  │
   └─────────────┘                   └──────┬──────┘
                                            │ reset attempts
                                            ▼
                                     ┌─────────────┐
                                     │   RESTART   │───▶ CONNECTING
                                     └─────────────┘
```

**Backoff strategy:**
- Initial delay: 1 second
- Multiplier: 2x per attempt
- Max delay: 30 seconds
- Sequence: 1s → 2s → 4s → 8s → 16s → 30s → 30s...

**Stability detection:** Reset reconnect counter after connection held for 60 seconds.

## Terminal Output

**Startup banner:**
```
┌─────────────────────────────────────────────────────────────────┐
│  POLYMARKET MONITOR                                             │
│  Watching 3 markets for suspicious activity                     │
│  Alert threshold: 70 | Min size: $5,000                         │
└─────────────────────────────────────────────────────────────────┘

[14:32:01] Connected to wss://ws-live-data.polymarket.com
[14:32:01] Subscribed to: maduro-yes, bitcoin-100k, venezuela-invasion

Monitoring... (Ctrl+C to stop)
```

**Alert format:**
```
ALERT [14:35:22] ────────────────────────────────────────────────
  Market:  Will Maduro leave office by Jan 31?
  Wallet:  0x31a5...8ed9 (new account, 3 trades)
  Trade:   BUY $7,215 YES @ $0.08
  Score:   82/100 [SNIPER]

  Signals:
    Trade Size:      68/100 (40%) → 27.2
    Account History: 95/100 (35%) → 33.3
    Conviction:      86/100 (25%) → 21.5
────────────────────────────────────────────────────────────────────
```

**Verbose mode:**
```
[14:35:18] maduro | 0xa1b2...c3d4 | BUY $2,100 YES | Score: 34
[14:35:20] maduro | 0xd4e5...f6a7 | SELL $800 NO  | Score: 22
[14:35:22] maduro | 0x31a5...8ed9 | BUY $7,215 YES | Score: 82 ALERT
```

**Color scheme:**

| Element | Color | Chalk |
|---------|-------|-------|
| YES outcome | Blue | `chalk.blue('YES')` |
| NO outcome | Yellow | `chalk.yellow('NO')` |
| Alert banner | Red | `chalk.red('ALERT')` |
| Score >= threshold | Red | `chalk.red(score)` |
| Wallet (repeated) | Magenta | existing behavior |

**Connection events:**
```
[14:40:15] Connection lost. Reconnecting (1/10)...
[14:40:16] Reconnected
```

## Configuration

**Additions to `config.json`:**
```json
{
  "watchlist": [
    "maduro-yes",
    "bitcoin-100k"
  ],
  "monitor": {
    "maxReconnects": 10,
    "retryDelaySeconds": 300,
    "stabilityThresholdSeconds": 60,
    "backoff": {
      "initialMs": 1000,
      "multiplier": 2,
      "maxMs": 30000
    }
  }
}
```

**Additions to `src/config.ts`:**
```typescript
export interface MonitorConfig {
  maxReconnects: number;
  retryDelaySeconds: number;
  stabilityThresholdSeconds: number;
  backoff: {
    initialMs: number;
    multiplier: number;
    maxMs: number;
  };
}
```

## Account Caching Strategy

**Problem:** Existing `AccountCache` persists forever with no TTL. For real-time monitoring, a cached "new account with 3 trades" could now have 100 trades.

**Solution: In-memory session cache with TTL**

```typescript
class MonitorEvaluator {
  private sessionCache = new Map<string, {
    history: AccountHistory;
    fetchedAt: number;
  }>();

  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  private isFresh(wallet: string): boolean {
    const entry = this.sessionCache.get(wallet);
    if (!entry) return false;
    return Date.now() - entry.fetchedAt < this.CACHE_TTL_MS;
  }
}
```

**Behavior:**
- Cache account data for 5 minutes (configurable)
- Don't persist to disk - each monitor session starts fresh
- Disk cache (`AccountCache`) used only by `analyze` command

## Limitations

**Size-based filtering:** Only trades above `--min-size` are evaluated. Small trades from suspicious accounts are missed. Future work: cached accounts could allow evaluating smaller trades without latency penalty.

## Future Work

| Feature | Priority | Notes |
|---------|----------|-------|
| **Mobile notifications** | High | Push alerts to phone when suspicious trade detected |
| **Failure notifications** | Medium | Notify when max reconnects exhausted (before retry delay) |
| **Smarter cache invalidation** | Medium | Invalidate when same wallet trades again |
| **Monitor mode B: Wallet watchlist** | Low | Track specific suspicious wallets across all markets |
| **Monitor mode C: Market-wide scan** | Low | Auto-discover and monitor all active markets |

## Dependencies

**New:**
- `@polymarket/real-time-data-client` - Official WebSocket client

**Existing (reused):**
- `TradeSizeSignal`, `AccountHistorySignal`, `ConvictionSignal`
- `SignalAggregator`
- `SubgraphClient` (for account lookups)
- `chalk` (for colored output)

## References

- [RTDS Documentation](https://docs.polymarket.com/developers/RTDS/RTDS-overview)
- [real-time-data-client GitHub](https://github.com/Polymarket/real-time-data-client)
- [CLOB WebSocket Overview](https://docs.polymarket.com/developers/CLOB/websocket/wss-overview)
