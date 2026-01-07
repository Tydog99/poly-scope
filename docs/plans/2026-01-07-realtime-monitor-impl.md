# Real-Time Monitor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `monitor` command that watches Polymarket markets via WebSocket and alerts on suspicious trades in real-time.

**Architecture:** WebSocket client subscribes to RTDS `activity/trades` topic. Incoming trades are filtered by size, scored using existing 3-signal system, and alerts displayed in terminal. Reconnection with exponential backoff handles disconnects.

**Tech Stack:** `@polymarket/real-time-data-client`, existing signals (`TradeSizeSignal`, `AccountHistorySignal`, `ConvictionSignal`), chalk for colored output.

**Design Doc:** `docs/plans/2026-01-07-realtime-monitor-design.md`

---

## Task 1: Add real-time-data-client dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the package**

Run:
```bash
npm install @polymarket/real-time-data-client
```

**Step 2: Verify installation**

Run:
```bash
npm ls @polymarket/real-time-data-client
```
Expected: Shows version installed

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @polymarket/real-time-data-client dependency"
```

---

## Task 2: Add monitor types

**Files:**
- Create: `src/monitor/types.ts`

**Step 1: Create types file**

```typescript
import type { AccountHistory } from '../signals/types.js';

/**
 * Trade event from RTDS WebSocket activity/trades subscription
 */
export interface RTDSTradeEvent {
  asset: string;
  conditionId: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  price: number;
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  size: number;
  slug: string;
  timestamp: number;
  transactionHash: string;
}

/**
 * Evaluated trade with scoring results
 */
export interface EvaluatedTrade {
  event: RTDSTradeEvent;
  score: number;
  isAlert: boolean;
  signals: {
    tradeSize: { score: number; weight: number; weighted: number };
    accountHistory: { score: number; weight: number; weighted: number };
    conviction: { score: number; weight: number; weighted: number };
  };
  account?: AccountHistory;
}

/**
 * Monitor configuration from config.json
 */
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

/**
 * Connection state for the WebSocket
 */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'backoff'
  | 'retry-wait';

/**
 * Options for the monitor command
 */
export interface MonitorOptions {
  markets: string[];
  minSize: number;
  threshold: number;
  maxReconnects: number;
  retryDelaySeconds: number;
  verbose: boolean;
}
```

**Step 2: Verify TypeScript compiles**

Run:
```bash
npx tsc --noEmit
```
Expected: No errors

**Step 3: Commit**

```bash
git add src/monitor/types.ts
git commit -m "feat(monitor): add type definitions"
```

---

## Task 3: Add monitor config to config system

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

**Step 1: Write failing test**

Add to `tests/config.test.ts`:

```typescript
it('includes monitor config with defaults', () => {
  const config = loadConfig();
  expect(config.monitor).toBeDefined();
  expect(config.monitor.maxReconnects).toBe(10);
  expect(config.monitor.retryDelaySeconds).toBe(300);
  expect(config.monitor.backoff.initialMs).toBe(1000);
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run tests/config.test.ts -t "includes monitor config"
```
Expected: FAIL - monitor property doesn't exist

**Step 3: Update config.ts**

Add to `src/config.ts` - add MonitorConfig interface and defaults:

```typescript
// Add to imports section (near top of file)
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

// Add to Config interface
export interface Config {
  // ... existing fields ...
  watchlist: string[];
  monitor: MonitorConfig;
}

// Add to defaultConfig
const defaultConfig: Config = {
  // ... existing defaults ...
  watchlist: [],
  monitor: {
    maxReconnects: 10,
    retryDelaySeconds: 300,
    stabilityThresholdSeconds: 60,
    backoff: {
      initialMs: 1000,
      multiplier: 2,
      maxMs: 30000,
    },
  },
};
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run tests/config.test.ts -t "includes monitor config"
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add monitor configuration with defaults"
```

---

## Task 4: Create stream wrapper with reconnection logic

**Files:**
- Create: `src/monitor/stream.ts`
- Create: `tests/monitor/stream.test.ts`

**Step 1: Write failing test for backoff calculation**

Create `tests/monitor/stream.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { calculateBackoff } from '../src/monitor/stream.js';

describe('MonitorStream', () => {
  describe('calculateBackoff', () => {
    it('returns initial delay on first attempt', () => {
      const delay = calculateBackoff(0, { initialMs: 1000, multiplier: 2, maxMs: 30000 });
      expect(delay).toBe(1000);
    });

    it('doubles delay on each attempt', () => {
      const config = { initialMs: 1000, multiplier: 2, maxMs: 30000 };
      expect(calculateBackoff(1, config)).toBe(2000);
      expect(calculateBackoff(2, config)).toBe(4000);
      expect(calculateBackoff(3, config)).toBe(8000);
    });

    it('caps delay at maxMs', () => {
      const config = { initialMs: 1000, multiplier: 2, maxMs: 30000 };
      expect(calculateBackoff(10, config)).toBe(30000);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run tests/monitor/stream.test.ts
```
Expected: FAIL - module not found

**Step 3: Create stream.ts with backoff function**

Create `src/monitor/stream.ts`:

```typescript
import { RealTimeDataClient } from '@polymarket/real-time-data-client';
import { EventEmitter } from 'events';
import type { RTDSTradeEvent, ConnectionState, MonitorConfig } from './types.js';

interface BackoffConfig {
  initialMs: number;
  multiplier: number;
  maxMs: number;
}

/**
 * Calculate backoff delay for reconnection attempt
 */
export function calculateBackoff(attempt: number, config: BackoffConfig): number {
  const delay = config.initialMs * Math.pow(config.multiplier, attempt);
  return Math.min(delay, config.maxMs);
}

interface MonitorStreamEvents {
  trade: (event: RTDSTradeEvent) => void;
  connected: () => void;
  disconnected: () => void;
  reconnecting: (attempt: number, maxAttempts: number) => void;
  retryWait: (seconds: number) => void;
  error: (error: Error) => void;
}

/**
 * WebSocket stream wrapper with reconnection logic
 */
export class MonitorStream extends EventEmitter {
  private client: RealTimeDataClient | null = null;
  private marketSlugs: string[];
  private config: MonitorConfig;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(marketSlugs: string[], config: MonitorConfig) {
    super();
    this.marketSlugs = marketSlugs;
    this.config = config;
  }

  /**
   * Start the WebSocket connection
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /**
   * Stop the WebSocket connection
   */
  stop(): void {
    this.stopped = true;
    this.clearStabilityTimer();
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this.state = 'disconnected';
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    this.state = 'connecting';

    try {
      this.client = new RealTimeDataClient({
        onConnect: (client) => {
          // Subscribe to trades for each market
          const subscriptions = this.marketSlugs.map(slug => ({
            topic: 'activity' as const,
            type: 'trades' as const,
            filters: JSON.stringify({ market_slug: slug }),
          }));

          client.subscribe({ subscriptions });

          this.state = 'connected';
          this.emit('connected');
          this.startStabilityTimer();
        },

        onMessage: (_client, message) => {
          if (message.topic === 'activity' && message.type === 'trades') {
            const trade = message.payload as RTDSTradeEvent;
            this.emit('trade', trade);
          }
        },

        onError: (error) => {
          this.emit('error', error);
          this.handleDisconnect();
        },

        onClose: () => {
          this.handleDisconnect();
        },
      });

      this.client.connect();
    } catch (error) {
      this.emit('error', error as Error);
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    if (this.stopped) return;

    this.clearStabilityTimer();
    this.state = 'disconnected';
    this.emit('disconnected');

    this.attemptReconnect();
  }

  private async attemptReconnect(): Promise<void> {
    if (this.stopped) return;

    if (this.reconnectAttempts >= this.config.maxReconnects) {
      // Exhausted reconnects, wait for retry delay
      this.state = 'retry-wait';
      this.emit('retryWait', this.config.retryDelaySeconds);

      await this.sleep(this.config.retryDelaySeconds * 1000);

      // Reset and try again
      this.reconnectAttempts = 0;
      await this.connect();
      return;
    }

    this.state = 'reconnecting';
    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts, this.config.maxReconnects);

    const backoffMs = calculateBackoff(
      this.reconnectAttempts - 1,
      this.config.backoff
    );

    this.state = 'backoff';
    await this.sleep(backoffMs);

    if (!this.stopped) {
      await this.connect();
    }
  }

  private startStabilityTimer(): void {
    this.clearStabilityTimer();
    this.stabilityTimer = setTimeout(() => {
      // Connection stable, reset reconnect counter
      this.reconnectAttempts = 0;
    }, this.config.stabilityThresholdSeconds * 1000);
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

**Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run tests/monitor/stream.test.ts
```
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/monitor/stream.ts tests/monitor/stream.test.ts
git commit -m "feat(monitor): add WebSocket stream with reconnection logic"
```

---

## Task 5: Create trade evaluator with session cache

**Files:**
- Create: `src/monitor/evaluator.ts`
- Create: `tests/monitor/evaluator.test.ts`

**Step 1: Write failing test**

Create `tests/monitor/evaluator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MonitorEvaluator } from '../src/monitor/evaluator.js';
import type { RTDSTradeEvent } from '../src/monitor/types.js';

describe('MonitorEvaluator', () => {
  const mockTradeEvent: RTDSTradeEvent = {
    asset: '123',
    conditionId: 'cond123',
    eventSlug: 'test-event',
    outcome: 'Yes',
    outcomeIndex: 0,
    price: 0.25,
    proxyWallet: '0xabc123',
    side: 'BUY',
    size: 10000,
    slug: 'test-market',
    timestamp: Date.now() / 1000,
    transactionHash: '0xtx123',
  };

  describe('shouldEvaluate', () => {
    it('returns false for trades below minSize', () => {
      const evaluator = new MonitorEvaluator({ minSize: 5000, threshold: 70 });
      const smallTrade = { ...mockTradeEvent, size: 100, price: 0.5 };
      expect(evaluator.shouldEvaluate(smallTrade)).toBe(false);
    });

    it('returns true for trades at or above minSize', () => {
      const evaluator = new MonitorEvaluator({ minSize: 5000, threshold: 70 });
      const largeTrade = { ...mockTradeEvent, size: 10000, price: 0.5 };
      expect(evaluator.shouldEvaluate(largeTrade)).toBe(true);
    });
  });

  describe('session cache', () => {
    it('caches account data for repeated evaluations', async () => {
      const evaluator = new MonitorEvaluator({ minSize: 5000, threshold: 70 });

      // Check cache miss
      expect(evaluator.isCached(mockTradeEvent.proxyWallet)).toBe(false);

      // Simulate caching
      evaluator.cacheAccount(mockTradeEvent.proxyWallet, {
        wallet: mockTradeEvent.proxyWallet,
        totalTrades: 5,
        firstTradeDate: new Date(),
        lastTradeDate: new Date(),
        totalVolumeUsd: 50000,
        dataSource: 'subgraph',
      });

      // Check cache hit
      expect(evaluator.isCached(mockTradeEvent.proxyWallet)).toBe(true);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run tests/monitor/evaluator.test.ts
```
Expected: FAIL - module not found

**Step 3: Create evaluator.ts**

Create `src/monitor/evaluator.ts`:

```typescript
import type { RTDSTradeEvent, EvaluatedTrade } from './types.js';
import type { AccountHistory, Trade } from '../signals/types.js';
import { TradeSizeSignal } from '../signals/tradeSize.js';
import { AccountHistorySignal } from '../signals/accountHistory.js';
import { ConvictionSignal } from '../signals/conviction.js';
import { loadConfig } from '../config.js';

interface CacheEntry {
  history: AccountHistory;
  fetchedAt: number;
}

interface EvaluatorOptions {
  minSize: number;
  threshold: number;
  cacheTtlMs?: number;
}

/**
 * Evaluates trades for suspicious activity with session-based caching
 */
export class MonitorEvaluator {
  private minSize: number;
  private threshold: number;
  private cacheTtlMs: number;
  private sessionCache = new Map<string, CacheEntry>();

  private tradeSizeSignal: TradeSizeSignal;
  private accountHistorySignal: AccountHistorySignal;
  private convictionSignal: ConvictionSignal;

  constructor(options: EvaluatorOptions) {
    this.minSize = options.minSize;
    this.threshold = options.threshold;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000; // 5 minutes default

    const config = loadConfig();
    this.tradeSizeSignal = new TradeSizeSignal(config);
    this.accountHistorySignal = new AccountHistorySignal(config);
    this.convictionSignal = new ConvictionSignal(config);
  }

  /**
   * Check if trade should be evaluated based on size
   */
  shouldEvaluate(event: RTDSTradeEvent): boolean {
    const valueUsd = event.size * event.price;
    return valueUsd >= this.minSize;
  }

  /**
   * Check if account is in session cache and still fresh
   */
  isCached(wallet: string): boolean {
    const entry = this.sessionCache.get(wallet.toLowerCase());
    if (!entry) return false;
    return Date.now() - entry.fetchedAt < this.cacheTtlMs;
  }

  /**
   * Get cached account history
   */
  getCached(wallet: string): AccountHistory | null {
    if (!this.isCached(wallet)) return null;
    return this.sessionCache.get(wallet.toLowerCase())?.history ?? null;
  }

  /**
   * Cache account history
   */
  cacheAccount(wallet: string, history: AccountHistory): void {
    this.sessionCache.set(wallet.toLowerCase(), {
      history,
      fetchedAt: Date.now(),
    });
  }

  /**
   * Convert RTDS trade event to internal Trade type
   */
  normalizeEvent(event: RTDSTradeEvent): Trade {
    return {
      id: event.transactionHash,
      wallet: event.proxyWallet,
      side: event.side,
      outcome: event.outcomeIndex === 0 ? 'Yes' : 'No',
      size: event.size,
      price: event.price,
      valueUsd: event.size * event.price,
      timestamp: event.timestamp,
      market: event.slug,
    };
  }

  /**
   * Evaluate a trade and return scoring results
   */
  evaluate(event: RTDSTradeEvent, account: AccountHistory | null): EvaluatedTrade {
    const trade = this.normalizeEvent(event);

    // Score trade size (always available)
    const tradeSizeResult = this.tradeSizeSignal.score(trade, [trade]);

    // Score account history (may be null)
    const accountHistoryResult = account
      ? this.accountHistorySignal.score(trade, account)
      : { score: 50, weight: 0.35, details: 'Account data unavailable' };

    // Score conviction (simplified - uses trade value vs account volume)
    const convictionResult = this.convictionSignal.score(
      trade,
      account?.totalVolumeUsd ?? trade.valueUsd
    );

    // Calculate weighted total
    const tradeSizeWeighted = tradeSizeResult.score * tradeSizeResult.weight;
    const accountHistoryWeighted = accountHistoryResult.score * accountHistoryResult.weight;
    const convictionWeighted = convictionResult.score * convictionResult.weight;

    const totalScore = Math.round(
      tradeSizeWeighted + accountHistoryWeighted + convictionWeighted
    );

    return {
      event,
      score: totalScore,
      isAlert: totalScore >= this.threshold,
      signals: {
        tradeSize: {
          score: tradeSizeResult.score,
          weight: tradeSizeResult.weight,
          weighted: tradeSizeWeighted,
        },
        accountHistory: {
          score: accountHistoryResult.score,
          weight: accountHistoryResult.weight,
          weighted: accountHistoryWeighted,
        },
        conviction: {
          score: convictionResult.score,
          weight: convictionResult.weight,
          weighted: convictionWeighted,
        },
      },
      account: account ?? undefined,
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run tests/monitor/evaluator.test.ts
```
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/monitor/evaluator.ts tests/monitor/evaluator.test.ts
git commit -m "feat(monitor): add trade evaluator with session cache"
```

---

## Task 6: Create monitor output formatter

**Files:**
- Modify: `src/output/cli.ts`
- Create: `tests/output/monitor.test.ts`

**Step 1: Write failing test**

Create `tests/output/monitor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatMonitorAlert, formatMonitorTrade } from '../src/output/cli.js';
import type { EvaluatedTrade, RTDSTradeEvent } from '../src/monitor/types.js';

describe('Monitor Output', () => {
  const mockEvent: RTDSTradeEvent = {
    asset: '123',
    conditionId: 'cond123',
    eventSlug: 'test-event',
    outcome: 'Yes',
    outcomeIndex: 0,
    price: 0.08,
    proxyWallet: '0x31a56e9e690c621ed21de08cb559e9524cdb8ed9',
    side: 'BUY',
    size: 7215,
    slug: 'maduro-yes',
    timestamp: 1704288922,
    transactionHash: '0xtx123',
  };

  const mockEvaluated: EvaluatedTrade = {
    event: mockEvent,
    score: 82,
    isAlert: true,
    signals: {
      tradeSize: { score: 68, weight: 0.4, weighted: 27.2 },
      accountHistory: { score: 95, weight: 0.35, weighted: 33.25 },
      conviction: { score: 86, weight: 0.25, weighted: 21.5 },
    },
    account: {
      wallet: mockEvent.proxyWallet,
      totalTrades: 3,
      firstTradeDate: new Date('2025-12-27'),
      lastTradeDate: new Date('2026-01-03'),
      totalVolumeUsd: 404357,
      dataSource: 'subgraph',
    },
  };

  describe('formatMonitorTrade', () => {
    it('formats verbose trade line', () => {
      const output = formatMonitorTrade(mockEvaluated, false);
      expect(output).toContain('maduro-yes');
      expect(output).toContain('0x31a5');
      expect(output).toContain('BUY');
      expect(output).toContain('7,215');
      expect(output).toContain('82');
    });
  });

  describe('formatMonitorAlert', () => {
    it('includes market and wallet info', () => {
      const output = formatMonitorAlert(mockEvaluated, 'Will Maduro leave office?');
      expect(output).toContain('ALERT');
      expect(output).toContain('Will Maduro leave office?');
      expect(output).toContain('0x31a5');
    });

    it('includes signal breakdown', () => {
      const output = formatMonitorAlert(mockEvaluated, 'Test Market');
      expect(output).toContain('Trade Size');
      expect(output).toContain('68');
      expect(output).toContain('Account History');
      expect(output).toContain('95');
      expect(output).toContain('Conviction');
      expect(output).toContain('86');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run tests/output/monitor.test.ts
```
Expected: FAIL - formatMonitorAlert not found

**Step 3: Add monitor output functions to cli.ts**

Add to `src/output/cli.ts`:

```typescript
import type { EvaluatedTrade } from '../monitor/types.js';

/**
 * Format a trade for verbose monitor output
 * Color: YES = blue, NO = yellow
 */
export function formatMonitorTrade(evaluated: EvaluatedTrade, useColors = true): string {
  const { event, score, isAlert } = evaluated;
  const time = new Date(event.timestamp * 1000).toLocaleTimeString('en-US', { hour12: false });
  const walletShort = `${event.proxyWallet.slice(0, 6)}...${event.proxyWallet.slice(-4)}`;
  const valueUsd = (event.size * event.price).toLocaleString('en-US', { maximumFractionDigits: 0 });

  const outcome = event.outcomeIndex === 0 ? 'YES' : 'NO';
  const outcomeColored = useColors
    ? (outcome === 'YES' ? chalk.blue(outcome) : chalk.yellow(outcome))
    : outcome;

  const scoreStr = useColors && isAlert ? chalk.red(score.toString()) : score.toString();
  const alertMarker = isAlert ? (useColors ? chalk.red(' 🚨') : ' ALERT') : '';

  return `[${time}] ${event.slug} | ${walletShort} | ${event.side} $${valueUsd} ${outcomeColored} | Score: ${scoreStr}${alertMarker}`;
}

/**
 * Format a full alert with signal breakdown
 */
export function formatMonitorAlert(evaluated: EvaluatedTrade, marketQuestion: string): string {
  const { event, score, signals, account } = evaluated;
  const time = new Date(event.timestamp * 1000).toLocaleTimeString('en-US', { hour12: false });
  const walletShort = `${event.proxyWallet.slice(0, 6)}...${event.proxyWallet.slice(-4)}`;
  const valueUsd = (event.size * event.price).toLocaleString('en-US', { maximumFractionDigits: 0 });

  const outcome = event.outcomeIndex === 0 ? 'YES' : 'NO';
  const outcomeColored = outcome === 'YES' ? chalk.blue(outcome) : chalk.yellow(outcome);

  const accountInfo = account
    ? `${account.totalTrades} trades`
    : 'unknown history';

  const lines = [
    '',
    chalk.red(`🚨 ALERT [${time}]`) + ' ' + '─'.repeat(50),
    `  Market:  ${marketQuestion}`,
    `  Wallet:  ${walletShort} (${accountInfo})`,
    `  Trade:   ${event.side} $${valueUsd} ${outcomeColored} @ $${event.price.toFixed(2)}`,
    `  Score:   ${chalk.red(score.toString())}/100`,
    '',
    '  Signals:',
    `    Trade Size:      ${signals.tradeSize.score}/100 (${Math.round(signals.tradeSize.weight * 100)}%) → ${signals.tradeSize.weighted.toFixed(1)}`,
    `    Account History: ${signals.accountHistory.score}/100 (${Math.round(signals.accountHistory.weight * 100)}%) → ${signals.accountHistory.weighted.toFixed(1)}`,
    `    Conviction:      ${signals.conviction.score}/100 (${Math.round(signals.conviction.weight * 100)}%) → ${signals.conviction.weighted.toFixed(1)}`,
    '─'.repeat(68),
  ];

  return lines.join('\n');
}

/**
 * Format monitor startup banner
 */
export function formatMonitorBanner(markets: string[], threshold: number, minSize: number): string {
  const lines = [
    '┌' + '─'.repeat(66) + '┐',
    '│  ' + chalk.bold('POLYMARKET MONITOR') + ' '.repeat(47) + '│',
    `│  Watching ${markets.length} market${markets.length === 1 ? '' : 's'} for suspicious activity` + ' '.repeat(Math.max(0, 28 - markets.length.toString().length)) + '│',
    `│  Alert threshold: ${threshold} | Min size: $${minSize.toLocaleString()}` + ' '.repeat(Math.max(0, 30 - threshold.toString().length - minSize.toLocaleString().length)) + '│',
    '└' + '─'.repeat(66) + '┘',
  ];
  return lines.join('\n');
}
```

**Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run tests/output/monitor.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/output/cli.ts tests/output/monitor.test.ts
git commit -m "feat(output): add monitor alert and trade formatters"
```

---

## Task 7: Create monitor command

**Files:**
- Create: `src/commands/monitor.ts`

**Step 1: Create the command file**

Create `src/commands/monitor.ts`:

```typescript
import chalk from 'chalk';
import { MonitorStream } from '../monitor/stream.js';
import { MonitorEvaluator } from '../monitor/evaluator.js';
import { AccountFetcher } from '../api/accounts.js';
import { SubgraphClient } from '../api/subgraph.js';
import { resolveSlug } from '../api/slug.js';
import { loadConfig } from '../config.js';
import { formatMonitorBanner, formatMonitorTrade, formatMonitorAlert } from '../output/cli.js';
import type { MonitorOptions } from '../monitor/types.js';

/**
 * Execute the monitor command
 */
export async function executeMonitor(options: MonitorOptions): Promise<void> {
  const config = loadConfig();

  // Merge CLI markets with config watchlist
  const allMarkets = [...new Set([...options.markets, ...config.watchlist])];

  if (allMarkets.length === 0) {
    console.error(chalk.red('Error: No markets specified. Use -m or add to config watchlist.'));
    process.exit(1);
  }

  // Resolve market slugs to verify they exist
  console.log('Resolving markets...');
  const resolvedMarkets: Array<{ slug: string; question: string }> = [];

  for (const market of allMarkets) {
    try {
      const resolved = await resolveSlug(market);
      resolvedMarkets.push({ slug: market, question: resolved.question || market });
    } catch (error) {
      console.error(chalk.yellow(`Warning: Could not resolve market "${market}", skipping`));
    }
  }

  if (resolvedMarkets.length === 0) {
    console.error(chalk.red('Error: No valid markets found.'));
    process.exit(1);
  }

  // Initialize components
  const subgraphClient = new SubgraphClient();
  const accountFetcher = new AccountFetcher({ subgraphClient });
  const evaluator = new MonitorEvaluator({
    minSize: options.minSize,
    threshold: options.threshold,
  });

  const streamConfig = {
    maxReconnects: options.maxReconnects,
    retryDelaySeconds: options.retryDelaySeconds,
    stabilityThresholdSeconds: config.monitor.stabilityThresholdSeconds,
    backoff: config.monitor.backoff,
  };

  const stream = new MonitorStream(
    resolvedMarkets.map(m => m.slug),
    streamConfig
  );

  // Market slug to question map for alerts
  const marketQuestions = new Map(resolvedMarkets.map(m => [m.slug, m.question]));

  // Display startup banner
  console.log(formatMonitorBanner(
    resolvedMarkets.map(m => m.slug),
    options.threshold,
    options.minSize
  ));
  console.log();

  // Set up event handlers
  stream.on('connected', () => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(chalk.green(`[${time}] Connected to WebSocket`));
    console.log(chalk.dim(`[${time}] Subscribed to: ${resolvedMarkets.map(m => m.slug).join(', ')}`));
    console.log();
    console.log('Monitoring... (Ctrl+C to stop)');
    console.log();
  });

  stream.on('disconnected', () => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(chalk.yellow(`[${time}] Connection lost`));
  });

  stream.on('reconnecting', (attempt, max) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(chalk.yellow(`[${time}] Reconnecting (${attempt}/${max})...`));
  });

  stream.on('retryWait', (seconds) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(chalk.red(`[${time}] Max reconnections reached. Retrying in ${seconds}s...`));
  });

  stream.on('error', (error) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.error(chalk.red(`[${time}] Error: ${error.message}`));
  });

  stream.on('trade', async (event) => {
    // Quick filter by size
    if (!evaluator.shouldEvaluate(event)) {
      return;
    }

    // Get account history (from cache or fetch)
    let account = evaluator.getCached(event.proxyWallet);

    if (!account) {
      try {
        account = await accountFetcher.getAccountHistory(event.proxyWallet);
        if (account) {
          evaluator.cacheAccount(event.proxyWallet, account);
        }
      } catch (error) {
        // Continue without account data
      }
    }

    // Evaluate the trade
    const evaluated = evaluator.evaluate(event, account);

    // Output based on mode
    if (evaluated.isAlert) {
      const question = marketQuestions.get(event.slug) || event.slug;
      console.log(formatMonitorAlert(evaluated, question));
    } else if (options.verbose) {
      console.log(formatMonitorTrade(evaluated));
    }
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log();
    console.log(chalk.dim('Stopping monitor...'));
    stream.stop();
    process.exit(0);
  });

  // Start the stream
  await stream.start();
}
```

**Step 2: Verify TypeScript compiles**

Run:
```bash
npx tsc --noEmit
```
Expected: No errors (may need to fix imports)

**Step 3: Commit**

```bash
git add src/commands/monitor.ts
git commit -m "feat(commands): add monitor command implementation"
```

---

## Task 8: Register monitor command in CLI

**Files:**
- Modify: `src/index.ts`

**Step 1: Add monitor command to CLI**

Add to `src/index.ts` after the existing command registrations:

```typescript
import { executeMonitor } from './commands/monitor.js';

// Add monitor command
program
  .command('monitor')
  .description('Watch markets in real-time for suspicious activity')
  .option('-m, --market <slugs>', 'Comma-separated market slugs to watch', (val) => val.split(','))
  .option('--min-size <usd>', 'Minimum trade size to evaluate', parseInt, 5000)
  .option('--threshold <score>', 'Alert threshold (0-100)', parseInt, 70)
  .option('--max-reconnects <n>', 'Max reconnection attempts', parseInt, 10)
  .option('--retry-delay <seconds>', 'Delay after max reconnects', parseInt, 300)
  .option('--verbose', 'Show all evaluated trades', false)
  .action(async (options) => {
    await executeMonitor({
      markets: options.market || [],
      minSize: options.minSize,
      threshold: options.threshold,
      maxReconnects: options.maxReconnects,
      retryDelaySeconds: options.retryDelay,
      verbose: options.verbose,
    });
  });
```

**Step 2: Verify CLI builds and shows help**

Run:
```bash
npm run build && ./dist/index.js monitor --help
```
Expected: Shows monitor command help with all options

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): register monitor command"
```

---

## Task 9: Add index export for monitor module

**Files:**
- Create: `src/monitor/index.ts`

**Step 1: Create index file**

Create `src/monitor/index.ts`:

```typescript
export * from './types.js';
export * from './stream.js';
export * from './evaluator.js';
```

**Step 2: Verify build**

Run:
```bash
npm run build
```
Expected: Builds successfully

**Step 3: Commit**

```bash
git add src/monitor/index.ts
git commit -m "feat(monitor): add module index exports"
```

---

## Task 10: Manual integration test

**Step 1: Run monitor with a test market**

Run:
```bash
npm run dev -- monitor -m presidential-election-2028 --verbose --min-size 100
```

Expected behavior:
- Shows startup banner
- Connects to WebSocket
- Shows trades in verbose mode (if any occur)
- Ctrl+C gracefully stops

**Step 2: Test reconnection (optional)**

Disconnect network briefly and verify reconnection messages appear.

**Step 3: Document any issues found**

Create notes for any bugs discovered during manual testing.

---

## Task 11: Update PROJECT_STATUS.md

**Files:**
- Modify: `PROJECT_STATUS.md`

**Step 1: Add monitor command to status**

Add under "Implemented Commands":

```markdown
3. **`monitor`** - Real-time market surveillance
   - Watches markets via RTDS WebSocket for suspicious trades
   - Alerts when trades score above threshold (default 70)
   - Quick-filters by minimum trade size (default $5k)
   - Auto-reconnects with exponential backoff
   - Color-coded output: YES (blue), NO (yellow)
   - Uses 5-minute in-memory cache for account lookups
```

Update the "Missing/Incomplete Features" section to move real-time monitoring to "Implemented".

**Step 2: Commit**

```bash
git add PROJECT_STATUS.md
git commit -m "docs: update PROJECT_STATUS with monitor command"
```

---

## Task 12: Update README with monitor documentation

**Files:**
- Modify: `README.md`

**Step 1: Add monitor section with diagram**

Add after the existing commands section:

```markdown
## Real-Time Monitoring

Watch markets live for suspicious trading activity:

```bash
# Monitor markets from config watchlist
npm run dev -- monitor

# Monitor specific markets
npm run dev -- monitor -m maduro-yes,bitcoin-100k

# Lower threshold to catch more potential cases
npm run dev -- monitor --threshold 50

# Verbose mode shows all evaluated trades
npm run dev -- monitor -m maduro-yes --verbose --min-size 1000
```

### How It Works

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
                          [skip]    🚨 ALERT
```

### Output Colors

| Element | Color |
|---------|-------|
| YES outcome | Blue |
| NO outcome | Yellow |
| Alert banner | Red |
| Score >= threshold | Red |

### Connection Handling

The monitor auto-reconnects on disconnect with exponential backoff:
- Sequence: 1s → 2s → 4s → 8s → 16s → 30s (max)
- After 10 failed reconnects, waits 5 minutes then retries
- Connection resets reconnect counter after 60s of stability
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add real-time monitoring section to README"
```

---

## Summary

| Task | Description | Est. Time |
|------|-------------|-----------|
| 1 | Add dependency | 2 min |
| 2 | Add types | 5 min |
| 3 | Add config | 5 min |
| 4 | Create stream wrapper | 15 min |
| 5 | Create evaluator | 10 min |
| 6 | Create output formatter | 10 min |
| 7 | Create monitor command | 10 min |
| 8 | Register CLI command | 5 min |
| 9 | Add module exports | 2 min |
| 10 | Manual testing | 10 min |
| 11 | Update PROJECT_STATUS | 5 min |
| 12 | Update README | 5 min |

**Total: ~85 minutes**
