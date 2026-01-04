# Polymarket Insider Trading Detector - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a TypeScript CLI that detects potential insider trading on Polymarket by scoring trades based on size/impact, account history, and directional conviction.

**Architecture:** Three-layer design with Data Layer (API clients), Detection Engine (signal calculators), and Output Layer (CLI formatting). Signals are independently calculated then aggregated via weighted sum to produce a 0-100 insider likelihood score.

**Tech Stack:** TypeScript, @polymarket/clob-client, commander (CLI), ws (WebSocket), chalk (colors), vitest (testing)

---

## Phase 1: Project Setup

### Task 1: Initialize TypeScript Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Step 1: Initialize npm project**

Run:
```bash
npm init -y
```

**Step 2: Install dependencies**

Run:
```bash
npm install @polymarket/clob-client commander ws chalk
npm install -D typescript vitest tsx @types/node @types/ws
```

**Step 3: Create tsconfig.json**

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 4: Update package.json scripts**

Add to `package.json`:
```json
{
  "type": "module",
  "bin": {
    "polymarket-insider": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest",
    "test:run": "vitest run"
  }
}
```

**Step 5: Create .gitignore**

Create `.gitignore`:
```
node_modules/
dist/
.env
*.log
```

**Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore package-lock.json
git commit -m "chore: initialize TypeScript project with dependencies"
```

---

### Task 2: Configuration System

**Files:**
- Create: `src/config.ts`
- Create: `config.json`
- Test: `tests/config.test.ts`

**Step 1: Write failing test for config loading**

Create `tests/config.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';

describe('config', () => {
  it('returns default config when no file exists', () => {
    const config = loadConfig('/nonexistent/path.json');
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('has correct default weights', () => {
    expect(DEFAULT_CONFIG.weights.tradeSize).toBe(40);
    expect(DEFAULT_CONFIG.weights.accountHistory).toBe(35);
    expect(DEFAULT_CONFIG.weights.conviction).toBe(25);
  });

  it('has correct default thresholds', () => {
    expect(DEFAULT_CONFIG.tradeSize.minAbsoluteUsd).toBe(5000);
    expect(DEFAULT_CONFIG.accountHistory.maxLifetimeTrades).toBe(10);
    expect(DEFAULT_CONFIG.conviction.minPositionPercent).toBe(80);
    expect(DEFAULT_CONFIG.alertThreshold).toBe(70);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL with "Cannot find module '../src/config.js'"

**Step 3: Write config implementation**

Create `src/config.ts`:
```typescript
import { readFileSync, existsSync } from 'fs';

export interface Config {
  weights: {
    tradeSize: number;
    accountHistory: number;
    conviction: number;
  };
  tradeSize: {
    minAbsoluteUsd: number;
    minImpactPercent: number;
    impactWindowMinutes: number;
  };
  accountHistory: {
    maxLifetimeTrades: number;
    maxAccountAgeDays: number;
    minDormancyDays: number;
  };
  conviction: {
    minPositionPercent: number;
  };
  alertThreshold: number;
  watchlist: string[];
}

export const DEFAULT_CONFIG: Config = {
  weights: {
    tradeSize: 40,
    accountHistory: 35,
    conviction: 25,
  },
  tradeSize: {
    minAbsoluteUsd: 5000,
    minImpactPercent: 2,
    impactWindowMinutes: 5,
  },
  accountHistory: {
    maxLifetimeTrades: 10,
    maxAccountAgeDays: 30,
    minDormancyDays: 60,
  },
  conviction: {
    minPositionPercent: 80,
  },
  alertThreshold: 70,
  watchlist: [],
};

export function loadConfig(path: string = './config.json'): Config {
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }

  const fileContent = readFileSync(path, 'utf-8');
  const userConfig = JSON.parse(fileContent) as Partial<Config>;

  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    weights: { ...DEFAULT_CONFIG.weights, ...userConfig.weights },
    tradeSize: { ...DEFAULT_CONFIG.tradeSize, ...userConfig.tradeSize },
    accountHistory: { ...DEFAULT_CONFIG.accountHistory, ...userConfig.accountHistory },
    conviction: { ...DEFAULT_CONFIG.conviction, ...userConfig.conviction },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/config.test.ts`
Expected: PASS

**Step 5: Create default config.json**

Create `config.json`:
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

**Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts config.json
git commit -m "feat: add configuration system with defaults"
```

---

## Phase 2: Signal Types & Interfaces

### Task 3: Define Core Types

**Files:**
- Create: `src/signals/types.ts`
- Create: `src/api/types.ts`

**Step 1: Create signal types**

Create `src/signals/types.ts`:
```typescript
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
  calculate(trade: Trade, context: SignalContext): Promise<SignalResult>;
}

export interface SignalContext {
  config: import('../config.js').Config;
  accountHistory?: AccountHistory;
  marketPrices?: PricePoint[];
}

export interface Trade {
  id: string;
  marketId: string;
  wallet: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  size: number; // number of shares
  price: number; // 0-1
  timestamp: Date;
  valueUsd: number; // size * price
}

export interface AccountHistory {
  wallet: string;
  totalTrades: number;
  firstTradeDate: Date | null;
  lastTradeDate: Date | null;
  totalVolumeUsd: number;
}

export interface PricePoint {
  timestamp: Date;
  price: number;
}
```

**Step 2: Create API types**

Create `src/api/types.ts`:
```typescript
export interface Market {
  conditionId: string;
  questionId: string;
  question: string;
  outcomes: string[];
  resolutionSource: string;
  endDate: string;
  resolved: boolean;
  winningOutcome?: string;
}

export interface RawTrade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  timestamp: string;
  maker_address: string;
  taker_address: string;
}

export interface TradeHistoryResponse {
  data: RawTrade[];
  next_cursor?: string;
}
```

**Step 3: Commit**

```bash
git add src/signals/types.ts src/api/types.ts
git commit -m "feat: define core type interfaces for signals and API"
```

---

## Phase 3: Detection Signals

### Task 4: Trade Size Signal

**Files:**
- Create: `src/signals/tradeSize.ts`
- Test: `tests/signals/tradeSize.test.ts`

**Step 1: Write failing test**

Create `tests/signals/tradeSize.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { TradeSizeSignal } from '../../src/signals/tradeSize.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { Trade, SignalContext, PricePoint } from '../../src/signals/types.js';

const makeContext = (prices: PricePoint[] = []): SignalContext => ({
  config: DEFAULT_CONFIG,
  marketPrices: prices,
});

const makeTrade = (overrides: Partial<Trade> = {}): Trade => ({
  id: 'test-1',
  marketId: 'market-1',
  wallet: '0xabc',
  side: 'BUY',
  outcome: 'YES',
  size: 10000,
  price: 0.5,
  timestamp: new Date('2024-01-15T12:00:00Z'),
  valueUsd: 5000,
  ...overrides,
});

describe('TradeSizeSignal', () => {
  const signal = new TradeSizeSignal();

  it('returns 0 for trades below minimum USD threshold', async () => {
    const trade = makeTrade({ valueUsd: 1000 }); // below $5000 default
    const result = await signal.calculate(trade, makeContext());
    expect(result.score).toBe(0);
  });

  it('returns higher score for larger trades', async () => {
    const smallTrade = makeTrade({ valueUsd: 5000 });
    const largeTrade = makeTrade({ valueUsd: 50000 });

    const smallResult = await signal.calculate(smallTrade, makeContext());
    const largeResult = await signal.calculate(largeTrade, makeContext());

    expect(largeResult.score).toBeGreaterThan(smallResult.score);
  });

  it('includes market impact in score when price data available', async () => {
    const trade = makeTrade({
      valueUsd: 10000,
      timestamp: new Date('2024-01-15T12:00:00Z'),
    });

    const pricesWithImpact: PricePoint[] = [
      { timestamp: new Date('2024-01-15T11:58:00Z'), price: 0.20 },
      { timestamp: new Date('2024-01-15T12:02:00Z'), price: 0.30 },
    ];

    const resultWithImpact = await signal.calculate(trade, makeContext(pricesWithImpact));
    const resultNoImpact = await signal.calculate(trade, makeContext());

    expect(resultWithImpact.score).toBeGreaterThan(resultNoImpact.score);
  });

  it('has correct name and weight', () => {
    expect(signal.name).toBe('tradeSize');
    expect(signal.weight).toBe(40);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/signals/tradeSize.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Implement TradeSizeSignal**

Create `src/signals/tradeSize.ts`:
```typescript
import type { Signal, SignalResult, Trade, SignalContext, PricePoint } from './types.js';

export class TradeSizeSignal implements Signal {
  name = 'tradeSize';
  weight = 40;

  async calculate(trade: Trade, context: SignalContext): Promise<SignalResult> {
    const { config, marketPrices = [] } = context;
    const { minAbsoluteUsd, minImpactPercent, impactWindowMinutes } = config.tradeSize;

    // Check minimum threshold
    if (trade.valueUsd < minAbsoluteUsd) {
      return {
        name: this.name,
        score: 0,
        weight: this.weight,
        details: { reason: 'below_threshold', valueUsd: trade.valueUsd, minAbsoluteUsd },
      };
    }

    // Calculate size score (0-50 points) - scales logarithmically
    const sizeMultiple = trade.valueUsd / minAbsoluteUsd;
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
        valueUsd: trade.valueUsd,
        sizeScore: Math.round(sizeScore),
        impactPercent: impact,
        impactScore: Math.round(impactScore),
      },
    };
  }

  private calculateImpact(
    trade: Trade,
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

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/signals/tradeSize.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/signals/tradeSize.ts tests/signals/tradeSize.test.ts
git commit -m "feat: implement trade size signal with market impact scoring"
```

---

### Task 5: Account History Signal

**Files:**
- Create: `src/signals/accountHistory.ts`
- Test: `tests/signals/accountHistory.test.ts`

**Step 1: Write failing test**

Create `tests/signals/accountHistory.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AccountHistorySignal } from '../../src/signals/accountHistory.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { Trade, SignalContext, AccountHistory } from '../../src/signals/types.js';

const makeTrade = (): Trade => ({
  id: 'test-1',
  marketId: 'market-1',
  wallet: '0xabc',
  side: 'BUY',
  outcome: 'YES',
  size: 10000,
  price: 0.5,
  timestamp: new Date('2024-01-15T12:00:00Z'),
  valueUsd: 5000,
});

const makeContext = (history?: AccountHistory): SignalContext => ({
  config: DEFAULT_CONFIG,
  accountHistory: history,
});

describe('AccountHistorySignal', () => {
  const signal = new AccountHistorySignal();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns high score for new accounts with few trades', async () => {
    const history: AccountHistory = {
      wallet: '0xabc',
      totalTrades: 3,
      firstTradeDate: new Date('2024-01-13'), // 2 days old
      lastTradeDate: new Date('2024-01-15'),
      totalVolumeUsd: 10000,
    };

    const result = await signal.calculate(makeTrade(), makeContext(history));
    expect(result.score).toBeGreaterThan(70);
  });

  it('returns low score for established accounts', async () => {
    const history: AccountHistory = {
      wallet: '0xabc',
      totalTrades: 500,
      firstTradeDate: new Date('2023-01-01'), // over a year old
      lastTradeDate: new Date('2024-01-14'),
      totalVolumeUsd: 500000,
    };

    const result = await signal.calculate(makeTrade(), makeContext(history));
    expect(result.score).toBeLessThan(20);
  });

  it('returns high score for dormant accounts', async () => {
    const history: AccountHistory = {
      wallet: '0xabc',
      totalTrades: 50,
      firstTradeDate: new Date('2023-06-01'),
      lastTradeDate: new Date('2023-10-01'), // 106 days dormant
      totalVolumeUsd: 100000,
    };

    const result = await signal.calculate(makeTrade(), makeContext(history));
    expect(result.score).toBeGreaterThan(40);
  });

  it('returns max score when no history available', async () => {
    const result = await signal.calculate(makeTrade(), makeContext());
    expect(result.score).toBe(100);
  });

  it('has correct name and weight', () => {
    expect(signal.name).toBe('accountHistory');
    expect(signal.weight).toBe(35);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/signals/accountHistory.test.ts`
Expected: FAIL

**Step 3: Implement AccountHistorySignal**

Create `src/signals/accountHistory.ts`:
```typescript
import type { Signal, SignalResult, Trade, SignalContext } from './types.js';

export class AccountHistorySignal implements Signal {
  name = 'accountHistory';
  weight = 35;

  async calculate(trade: Trade, context: SignalContext): Promise<SignalResult> {
    const { config, accountHistory } = context;
    const { maxLifetimeTrades, maxAccountAgeDays, minDormancyDays } = config.accountHistory;

    // No history = maximum suspicion
    if (!accountHistory || !accountHistory.firstTradeDate) {
      return {
        name: this.name,
        score: 100,
        weight: this.weight,
        details: { reason: 'no_history' },
      };
    }

    const now = new Date();
    const accountAgeDays = Math.floor(
      (now.getTime() - accountHistory.firstTradeDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    const dormancyDays = accountHistory.lastTradeDate
      ? Math.floor(
          (trade.timestamp.getTime() - accountHistory.lastTradeDate.getTime()) / (1000 * 60 * 60 * 24)
        )
      : 0;

    // Calculate component scores (each 0-33)
    const tradeCountScore = this.scoreTradeCount(accountHistory.totalTrades, maxLifetimeTrades);
    const ageScore = this.scoreAccountAge(accountAgeDays, maxAccountAgeDays);
    const dormancyScore = this.scoreDormancy(dormancyDays, minDormancyDays);

    const totalScore = Math.round(tradeCountScore + ageScore + dormancyScore);

    return {
      name: this.name,
      score: Math.min(100, totalScore),
      weight: this.weight,
      details: {
        totalTrades: accountHistory.totalTrades,
        accountAgeDays,
        dormancyDays,
        tradeCountScore: Math.round(tradeCountScore),
        ageScore: Math.round(ageScore),
        dormancyScore: Math.round(dormancyScore),
      },
    };
  }

  private scoreTradeCount(count: number, threshold: number): number {
    if (count >= threshold * 10) return 0;
    if (count <= threshold) return 33;
    // Linear decay from threshold to threshold*10
    return 33 * (1 - (count - threshold) / (threshold * 9));
  }

  private scoreAccountAge(days: number, threshold: number): number {
    if (days >= threshold * 12) return 0; // Over a year
    if (days <= threshold) return 33;
    return 33 * (1 - (days - threshold) / (threshold * 11));
  }

  private scoreDormancy(days: number, threshold: number): number {
    if (days < threshold) return 0;
    // Score increases with dormancy, caps at 2x threshold
    const excess = days - threshold;
    return Math.min(34, (excess / threshold) * 34);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/signals/accountHistory.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/signals/accountHistory.ts tests/signals/accountHistory.test.ts
git commit -m "feat: implement account history signal for newness/dormancy detection"
```

---

### Task 6: Conviction Signal

**Files:**
- Create: `src/signals/conviction.ts`
- Test: `tests/signals/conviction.test.ts`

**Step 1: Write failing test**

Create `tests/signals/conviction.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { ConvictionSignal } from '../../src/signals/conviction.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { Trade, SignalContext, AccountHistory } from '../../src/signals/types.js';

const makeTrade = (overrides: Partial<Trade> = {}): Trade => ({
  id: 'test-1',
  marketId: 'market-1',
  wallet: '0xabc',
  side: 'BUY',
  outcome: 'YES',
  size: 10000,
  price: 0.5,
  timestamp: new Date('2024-01-15T12:00:00Z'),
  valueUsd: 5000,
  ...overrides,
});

const makeContext = (history?: Partial<AccountHistory>): SignalContext => ({
  config: DEFAULT_CONFIG,
  accountHistory: history ? {
    wallet: '0xabc',
    totalTrades: 10,
    firstTradeDate: new Date('2024-01-01'),
    lastTradeDate: new Date('2024-01-14'),
    totalVolumeUsd: 10000,
    ...history,
  } : undefined,
});

describe('ConvictionSignal', () => {
  const signal = new ConvictionSignal();

  it('returns high score when trade is large portion of total volume', async () => {
    const trade = makeTrade({ valueUsd: 9000 });
    const context = makeContext({ totalVolumeUsd: 10000 }); // 90% of portfolio

    const result = await signal.calculate(trade, context);
    expect(result.score).toBeGreaterThan(80);
  });

  it('returns low score for small portion trades', async () => {
    const trade = makeTrade({ valueUsd: 1000 });
    const context = makeContext({ totalVolumeUsd: 100000 }); // 1% of portfolio

    const result = await signal.calculate(trade, context);
    expect(result.score).toBeLessThan(20);
  });

  it('returns max score when no history available', async () => {
    const result = await signal.calculate(makeTrade(), makeContext());
    expect(result.score).toBe(100);
  });

  it('has correct name and weight', () => {
    expect(signal.name).toBe('conviction');
    expect(signal.weight).toBe(25);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/signals/conviction.test.ts`
Expected: FAIL

**Step 3: Implement ConvictionSignal**

Create `src/signals/conviction.ts`:
```typescript
import type { Signal, SignalResult, Trade, SignalContext } from './types.js';

export class ConvictionSignal implements Signal {
  name = 'conviction';
  weight = 25;

  async calculate(trade: Trade, context: SignalContext): Promise<SignalResult> {
    const { config, accountHistory } = context;
    const { minPositionPercent } = config.conviction;

    // No history = assume high conviction (risky bet on unknown account)
    if (!accountHistory) {
      return {
        name: this.name,
        score: 100,
        weight: this.weight,
        details: { reason: 'no_history' },
      };
    }

    // Calculate what percentage of their total volume this trade represents
    const totalVolume = accountHistory.totalVolumeUsd + trade.valueUsd;
    const tradePercent = (trade.valueUsd / totalVolume) * 100;

    // Score based on how much of portfolio is concentrated in this bet
    let score = 0;
    if (tradePercent >= minPositionPercent) {
      score = 100;
    } else if (tradePercent >= minPositionPercent / 2) {
      // Linear scale from 50% threshold to 80% threshold
      score = ((tradePercent - minPositionPercent / 2) / (minPositionPercent / 2)) * 100;
    } else {
      // Below 40%, low conviction
      score = (tradePercent / (minPositionPercent / 2)) * 30;
    }

    return {
      name: this.name,
      score: Math.round(Math.min(100, score)),
      weight: this.weight,
      details: {
        tradeValueUsd: trade.valueUsd,
        totalVolumeUsd: totalVolume,
        tradePercent: Math.round(tradePercent * 10) / 10,
      },
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/signals/conviction.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/signals/conviction.ts tests/signals/conviction.test.ts
git commit -m "feat: implement conviction signal for portfolio concentration detection"
```

---

### Task 7: Signal Aggregator

**Files:**
- Create: `src/signals/aggregator.ts`
- Test: `tests/signals/aggregator.test.ts`

**Step 1: Write failing test**

Create `tests/signals/aggregator.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { SignalAggregator } from '../../src/signals/aggregator.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { SignalResult } from '../../src/signals/types.js';

describe('SignalAggregator', () => {
  const aggregator = new SignalAggregator(DEFAULT_CONFIG);

  it('calculates weighted average of signals', () => {
    const signals: SignalResult[] = [
      { name: 'tradeSize', score: 100, weight: 40, details: {} },
      { name: 'accountHistory', score: 100, weight: 35, details: {} },
      { name: 'conviction', score: 100, weight: 25, details: {} },
    ];

    const result = aggregator.aggregate(signals);
    expect(result.total).toBe(100);
  });

  it('correctly weights different scores', () => {
    const signals: SignalResult[] = [
      { name: 'tradeSize', score: 50, weight: 40, details: {} },
      { name: 'accountHistory', score: 50, weight: 35, details: {} },
      { name: 'conviction', score: 50, weight: 25, details: {} },
    ];

    const result = aggregator.aggregate(signals);
    expect(result.total).toBe(50);
  });

  it('marks as alert when above threshold', () => {
    const signals: SignalResult[] = [
      { name: 'tradeSize', score: 80, weight: 40, details: {} },
      { name: 'accountHistory', score: 80, weight: 35, details: {} },
      { name: 'conviction', score: 80, weight: 25, details: {} },
    ];

    const result = aggregator.aggregate(signals);
    expect(result.isAlert).toBe(true);
    expect(result.total).toBe(80);
  });

  it('does not mark as alert when below threshold', () => {
    const signals: SignalResult[] = [
      { name: 'tradeSize', score: 50, weight: 40, details: {} },
      { name: 'accountHistory', score: 50, weight: 35, details: {} },
      { name: 'conviction', score: 50, weight: 25, details: {} },
    ];

    const result = aggregator.aggregate(signals);
    expect(result.isAlert).toBe(false);
  });

  it('includes all signal results in output', () => {
    const signals: SignalResult[] = [
      { name: 'tradeSize', score: 60, weight: 40, details: { foo: 'bar' } },
    ];

    const result = aggregator.aggregate(signals);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].details).toEqual({ foo: 'bar' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/signals/aggregator.test.ts`
Expected: FAIL

**Step 3: Implement SignalAggregator**

Create `src/signals/aggregator.ts`:
```typescript
import type { Config } from '../config.js';
import type { SignalResult, AggregatedScore } from './types.js';

export class SignalAggregator {
  constructor(private config: Config) {}

  aggregate(signals: SignalResult[]): AggregatedScore {
    const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);

    const weightedSum = signals.reduce((sum, signal) => {
      return sum + (signal.score * signal.weight);
    }, 0);

    const total = Math.round(weightedSum / totalWeight);

    return {
      total,
      signals,
      isAlert: total >= this.config.alertThreshold,
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/signals/aggregator.test.ts`
Expected: PASS

**Step 5: Create signals index**

Create `src/signals/index.ts`:
```typescript
export * from './types.js';
export { TradeSizeSignal } from './tradeSize.js';
export { AccountHistorySignal } from './accountHistory.js';
export { ConvictionSignal } from './conviction.js';
export { SignalAggregator } from './aggregator.js';
```

**Step 6: Commit**

```bash
git add src/signals/aggregator.ts tests/signals/aggregator.test.ts src/signals/index.ts
git commit -m "feat: implement signal aggregator with configurable alert threshold"
```

---

## Phase 4: API Layer

### Task 8: Polymarket Client

**Files:**
- Create: `src/api/client.ts`
- Test: `tests/api/client.test.ts`

**Step 1: Write failing test**

Create `tests/api/client.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PolymarketClient } from '../../src/api/client.js';

// Mock the clob-client
vi.mock('@polymarket/clob-client', () => ({
  ClobClient: vi.fn().mockImplementation(() => ({
    getMarket: vi.fn().mockResolvedValue({
      condition_id: 'test-condition',
      question: 'Test question?',
      tokens: [
        { token_id: 'yes-token', outcome: 'Yes' },
        { token_id: 'no-token', outcome: 'No' },
      ],
      end_date_iso: '2024-02-01T00:00:00Z',
    }),
  })),
}));

describe('PolymarketClient', () => {
  let client: PolymarketClient;

  beforeEach(() => {
    client = new PolymarketClient();
  });

  it('fetches market by condition ID', async () => {
    const market = await client.getMarket('test-condition');

    expect(market.conditionId).toBe('test-condition');
    expect(market.question).toBe('Test question?');
    expect(market.outcomes).toContain('Yes');
  });

  it('exposes correct API host', () => {
    expect(client.host).toContain('clob.polymarket.com');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/api/client.test.ts`
Expected: FAIL

**Step 3: Implement PolymarketClient**

Create `src/api/client.ts`:
```typescript
import { ClobClient } from '@polymarket/clob-client';
import type { Market } from './types.js';

const CLOB_HOST = 'https://clob.polymarket.com';

export class PolymarketClient {
  private clob: ClobClient;
  readonly host = CLOB_HOST;

  constructor() {
    this.clob = new ClobClient(CLOB_HOST);
  }

  async getMarket(conditionId: string): Promise<Market> {
    const raw = await this.clob.getMarket(conditionId);

    return {
      conditionId: raw.condition_id,
      questionId: raw.question_id ?? '',
      question: raw.question,
      outcomes: raw.tokens?.map((t: { outcome: string }) => t.outcome) ?? ['Yes', 'No'],
      resolutionSource: raw.resolution_source ?? '',
      endDate: raw.end_date_iso ?? '',
      resolved: raw.closed ?? false,
      winningOutcome: raw.winning_outcome,
    };
  }

  getClobClient(): ClobClient {
    return this.clob;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/api/client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/client.ts tests/api/client.test.ts
git commit -m "feat: implement Polymarket CLOB client wrapper"
```

---

### Task 9: Trade Fetcher

**Files:**
- Create: `src/api/trades.ts`
- Test: `tests/api/trades.test.ts`

**Step 1: Write failing test**

Create `tests/api/trades.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradeFetcher } from '../../src/api/trades.js';
import type { RawTrade } from '../../src/api/types.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockRawTrade: RawTrade = {
  id: 'trade-1',
  taker_order_id: 'order-1',
  market: 'market-1',
  asset_id: 'asset-1',
  side: 'BUY',
  size: '1000',
  price: '0.50',
  timestamp: '1705320000',
  maker_address: '0xmaker',
  taker_address: '0xtaker',
};

describe('TradeFetcher', () => {
  let fetcher: TradeFetcher;

  beforeEach(() => {
    fetcher = new TradeFetcher();
    mockFetch.mockReset();
  });

  it('fetches trades for a market', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [mockRawTrade] }),
    });

    const trades = await fetcher.getTradesForMarket('market-1');

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('trade-1');
    expect(trades[0].valueUsd).toBe(500); // 1000 * 0.50
  });

  it('handles pagination', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [mockRawTrade],
          next_cursor: 'cursor-1'
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [{ ...mockRawTrade, id: 'trade-2' }]
        }),
      });

    const trades = await fetcher.getTradesForMarket('market-1');

    expect(trades).toHaveLength(2);
  });

  it('converts raw trade to Trade interface', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [mockRawTrade] }),
    });

    const trades = await fetcher.getTradesForMarket('market-1');
    const trade = trades[0];

    expect(trade.side).toBe('BUY');
    expect(trade.price).toBe(0.5);
    expect(trade.size).toBe(1000);
    expect(trade.wallet).toBe('0xtaker');
    expect(trade.timestamp).toBeInstanceOf(Date);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/api/trades.test.ts`
Expected: FAIL

**Step 3: Implement TradeFetcher**

Create `src/api/trades.ts`:
```typescript
import type { Trade } from '../signals/types.js';
import type { RawTrade, TradeHistoryResponse } from './types.js';

const CLOB_HOST = 'https://clob.polymarket.com';

export class TradeFetcher {
  async getTradesForMarket(
    marketId: string,
    options: {
      after?: Date;
      before?: Date;
      outcome?: 'YES' | 'NO';
    } = {}
  ): Promise<Trade[]> {
    const allTrades: Trade[] = [];
    let cursor: string | undefined;

    do {
      const url = new URL(`${CLOB_HOST}/trades`);
      url.searchParams.set('market', marketId);
      if (cursor) url.searchParams.set('next_cursor', cursor);

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Failed to fetch trades: ${response.statusText}`);
      }

      const data: TradeHistoryResponse = await response.json();

      for (const raw of data.data) {
        const trade = this.convertTrade(raw, marketId);

        // Apply filters
        if (options.after && trade.timestamp < options.after) continue;
        if (options.before && trade.timestamp > options.before) continue;

        allTrades.push(trade);
      }

      cursor = data.next_cursor;
    } while (cursor);

    return allTrades;
  }

  private convertTrade(raw: RawTrade, marketId: string): Trade {
    const size = parseFloat(raw.size);
    const price = parseFloat(raw.price);

    return {
      id: raw.id,
      marketId,
      wallet: raw.taker_address,
      side: raw.side,
      outcome: 'YES', // Will be determined by asset_id mapping
      size,
      price,
      timestamp: new Date(parseInt(raw.timestamp) * 1000),
      valueUsd: size * price,
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/api/trades.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/trades.ts tests/api/trades.test.ts
git commit -m "feat: implement trade fetcher with pagination support"
```

---

### Task 10: Account History Fetcher

**Files:**
- Create: `src/api/accounts.ts`
- Test: `tests/api/accounts.test.ts`

**Step 1: Write failing test**

Create `tests/api/accounts.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountFetcher } from '../../src/api/accounts.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AccountFetcher', () => {
  let fetcher: AccountFetcher;

  beforeEach(() => {
    fetcher = new AccountFetcher();
    mockFetch.mockReset();
  });

  it('fetches account history', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { timestamp: '1704067200', size: '100', price: '0.5' }, // Jan 1
          { timestamp: '1705276800', size: '200', price: '0.3' }, // Jan 15
        ],
      }),
    });

    const history = await fetcher.getAccountHistory('0xwallet');

    expect(history.wallet).toBe('0xwallet');
    expect(history.totalTrades).toBe(2);
    expect(history.totalVolumeUsd).toBe(110); // 100*0.5 + 200*0.3
  });

  it('handles accounts with no trades', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    const history = await fetcher.getAccountHistory('0xnewbie');

    expect(history.totalTrades).toBe(0);
    expect(history.firstTradeDate).toBeNull();
    expect(history.lastTradeDate).toBeNull();
  });

  it('calculates first and last trade dates', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { timestamp: '1704067200', size: '100', price: '0.5' },
          { timestamp: '1705276800', size: '200', price: '0.3' },
        ],
      }),
    });

    const history = await fetcher.getAccountHistory('0xwallet');

    expect(history.firstTradeDate?.getTime()).toBe(1704067200000);
    expect(history.lastTradeDate?.getTime()).toBe(1705276800000);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/api/accounts.test.ts`
Expected: FAIL

**Step 3: Implement AccountFetcher**

Create `src/api/accounts.ts`:
```typescript
import type { AccountHistory } from '../signals/types.js';

const CLOB_HOST = 'https://clob.polymarket.com';

interface RawAccountTrade {
  timestamp: string;
  size: string;
  price: string;
}

export class AccountFetcher {
  async getAccountHistory(wallet: string): Promise<AccountHistory> {
    const url = new URL(`${CLOB_HOST}/trades`);
    url.searchParams.set('maker_address', wallet);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch account history: ${response.statusText}`);
    }

    const data: { data: RawAccountTrade[] } = await response.json();
    const trades = data.data;

    if (trades.length === 0) {
      return {
        wallet,
        totalTrades: 0,
        firstTradeDate: null,
        lastTradeDate: null,
        totalVolumeUsd: 0,
      };
    }

    const timestamps = trades.map(t => parseInt(t.timestamp) * 1000);
    const volumes = trades.map(t => parseFloat(t.size) * parseFloat(t.price));

    return {
      wallet,
      totalTrades: trades.length,
      firstTradeDate: new Date(Math.min(...timestamps)),
      lastTradeDate: new Date(Math.max(...timestamps)),
      totalVolumeUsd: volumes.reduce((sum, v) => sum + v, 0),
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/api/accounts.test.ts`
Expected: PASS

**Step 5: Create API index**

Create `src/api/index.ts`:
```typescript
export * from './types.js';
export { PolymarketClient } from './client.js';
export { TradeFetcher } from './trades.js';
export { AccountFetcher } from './accounts.js';
```

**Step 6: Commit**

```bash
git add src/api/accounts.ts tests/api/accounts.test.ts src/api/index.ts
git commit -m "feat: implement account history fetcher"
```

---

## Phase 5: CLI Output

### Task 11: CLI Reporter

**Files:**
- Create: `src/output/cli.ts`
- Create: `src/output/types.ts`
- Test: `tests/output/cli.test.ts`

**Step 1: Create output types**

Create `src/output/types.ts`:
```typescript
import type { AggregatedScore, Trade, AccountHistory } from '../signals/types.js';
import type { Market } from '../api/types.js';

export interface SuspiciousTrade {
  trade: Trade;
  score: AggregatedScore;
  accountHistory?: AccountHistory;
  priceImpact?: {
    before: number;
    after: number;
    changePercent: number;
  };
}

export interface AnalysisReport {
  market: Market;
  totalTrades: number;
  winningTrades: number;
  suspiciousTrades: SuspiciousTrade[];
  analyzedAt: Date;
}
```

**Step 2: Write failing test**

Create `tests/output/cli.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { CLIReporter } from '../../src/output/cli.js';
import type { AnalysisReport, SuspiciousTrade } from '../../src/output/types.js';

const mockReport: AnalysisReport = {
  market: {
    conditionId: 'test-123',
    questionId: 'q-1',
    question: 'Will X happen?',
    outcomes: ['Yes', 'No'],
    resolutionSource: '',
    endDate: '2024-02-01',
    resolved: true,
    winningOutcome: 'Yes',
  },
  totalTrades: 100,
  winningTrades: 45,
  suspiciousTrades: [
    {
      trade: {
        id: 't-1',
        marketId: 'test-123',
        wallet: '0x1a2b3c4d5e6f',
        side: 'BUY',
        outcome: 'YES',
        size: 50000,
        price: 0.12,
        timestamp: new Date('2024-01-15'),
        valueUsd: 6000,
      },
      score: {
        total: 94,
        signals: [
          { name: 'tradeSize', score: 95, weight: 40, details: {} },
          { name: 'accountHistory', score: 90, weight: 35, details: {} },
          { name: 'conviction', score: 98, weight: 25, details: {} },
        ],
        isAlert: true,
      },
      priceImpact: { before: 0.12, after: 0.19, changePercent: 58 },
    },
  ],
  analyzedAt: new Date(),
};

describe('CLIReporter', () => {
  const reporter = new CLIReporter();

  it('formats analysis report', () => {
    const output = reporter.formatAnalysisReport(mockReport);

    expect(output).toContain('Will X happen?');
    expect(output).toContain('Resolved YES');
    expect(output).toContain('94/100');
    expect(output).toContain('0x1a2b...6f');
  });

  it('truncates wallet addresses', () => {
    const truncated = reporter.truncateWallet('0x1234567890abcdef');
    expect(truncated).toBe('0x1234...ef');
  });

  it('formats USD values', () => {
    expect(reporter.formatUsd(1234.56)).toBe('$1,235');
    expect(reporter.formatUsd(1000000)).toBe('$1,000,000');
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test -- tests/output/cli.test.ts`
Expected: FAIL

**Step 4: Implement CLIReporter**

Create `src/output/cli.ts`:
```typescript
import chalk from 'chalk';
import type { AnalysisReport, SuspiciousTrade } from './types.js';

export class CLIReporter {
  formatAnalysisReport(report: AnalysisReport): string {
    const lines: string[] = [];

    // Header
    lines.push('');
    lines.push(chalk.bold(`Market: "${report.market.question}"`));
    lines.push(chalk.gray(`→ Resolved ${chalk.green(report.market.winningOutcome?.toUpperCase())}`));
    lines.push('');
    lines.push(chalk.gray(`Total trades: ${report.totalTrades} | Winning side: ${report.winningTrades}`));
    lines.push('');

    if (report.suspiciousTrades.length === 0) {
      lines.push(chalk.green('No suspicious trades detected.'));
      return lines.join('\n');
    }

    lines.push(chalk.bold.red('Top Suspicious Trades:'));
    lines.push(chalk.gray('━'.repeat(50)));

    report.suspiciousTrades.forEach((st, idx) => {
      lines.push(this.formatSuspiciousTrade(st, idx + 1));
      lines.push('');
    });

    return lines.join('\n');
  }

  private formatSuspiciousTrade(st: SuspiciousTrade, rank: number): string {
    const lines: string[] = [];
    const scoreColor = st.score.total >= 80 ? chalk.red : st.score.total >= 60 ? chalk.yellow : chalk.white;

    lines.push(`#${rank}  Score: ${scoreColor.bold(`${st.score.total}/100`)}`);
    lines.push(`    Wallet: ${chalk.cyan(this.truncateWallet(st.trade.wallet))}`);
    lines.push(`    Trade: ${this.formatUsd(st.trade.valueUsd)} ${st.trade.outcome} @ ${st.trade.price.toFixed(2)}`);

    if (st.priceImpact) {
      lines.push(`    Impact: ${st.priceImpact.before.toFixed(2)} → ${st.priceImpact.after.toFixed(2)} (+${st.priceImpact.changePercent}%)`);
    }

    if (st.accountHistory) {
      const age = st.accountHistory.firstTradeDate
        ? Math.floor((Date.now() - st.accountHistory.firstTradeDate.getTime()) / (1000 * 60 * 60 * 24))
        : 0;
      lines.push(`    Account: ${st.accountHistory.totalTrades} lifetime trades, ${age} days old`);
    }

    return lines.join('\n');
  }

  truncateWallet(wallet: string): string {
    if (wallet.length <= 10) return wallet;
    return `${wallet.slice(0, 6)}...${wallet.slice(-2)}`;
  }

  formatUsd(value: number): string {
    return '$' + Math.round(value).toLocaleString('en-US');
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npm test -- tests/output/cli.test.ts`
Expected: PASS

**Step 6: Create output index**

Create `src/output/index.ts`:
```typescript
export * from './types.js';
export { CLIReporter } from './cli.js';
```

**Step 7: Commit**

```bash
git add src/output/cli.ts src/output/types.ts tests/output/cli.test.ts src/output/index.ts
git commit -m "feat: implement CLI reporter with colored output"
```

---

## Phase 6: Analyze Command

### Task 12: Analyze Command Implementation

**Files:**
- Create: `src/commands/analyze.ts`
- Test: `tests/commands/analyze.test.ts`

**Step 1: Write failing test**

Create `tests/commands/analyze.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyzeCommand } from '../../src/commands/analyze.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

// Mock all dependencies
vi.mock('../../src/api/client.js', () => ({
  PolymarketClient: vi.fn().mockImplementation(() => ({
    getMarket: vi.fn().mockResolvedValue({
      conditionId: 'test-market',
      question: 'Test market?',
      outcomes: ['Yes', 'No'],
      resolved: true,
      winningOutcome: 'Yes',
    }),
  })),
}));

vi.mock('../../src/api/trades.js', () => ({
  TradeFetcher: vi.fn().mockImplementation(() => ({
    getTradesForMarket: vi.fn().mockResolvedValue([
      {
        id: 't1',
        marketId: 'test-market',
        wallet: '0xsuspicious',
        side: 'BUY',
        outcome: 'YES',
        size: 50000,
        price: 0.2,
        timestamp: new Date('2024-01-15'),
        valueUsd: 10000,
      },
    ]),
  })),
}));

vi.mock('../../src/api/accounts.js', () => ({
  AccountFetcher: vi.fn().mockImplementation(() => ({
    getAccountHistory: vi.fn().mockResolvedValue({
      wallet: '0xsuspicious',
      totalTrades: 2,
      firstTradeDate: new Date('2024-01-14'),
      lastTradeDate: new Date('2024-01-15'),
      totalVolumeUsd: 10000,
    }),
  })),
}));

describe('AnalyzeCommand', () => {
  let command: AnalyzeCommand;

  beforeEach(() => {
    command = new AnalyzeCommand(DEFAULT_CONFIG);
  });

  it('analyzes a market and returns report', async () => {
    const report = await command.execute({ marketId: 'test-market' });

    expect(report.market.conditionId).toBe('test-market');
    expect(report.suspiciousTrades.length).toBeGreaterThanOrEqual(0);
  });

  it('filters to winning side trades only', async () => {
    const report = await command.execute({ marketId: 'test-market' });

    // All suspicious trades should be on winning outcome
    report.suspiciousTrades.forEach(st => {
      expect(st.trade.outcome).toBe('YES');
    });
  });

  it('enriches high-scoring trades with account history', async () => {
    const report = await command.execute({ marketId: 'test-market' });

    report.suspiciousTrades.forEach(st => {
      if (st.score.total > 50) {
        expect(st.accountHistory).toBeDefined();
      }
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/commands/analyze.test.ts`
Expected: FAIL

**Step 3: Implement AnalyzeCommand**

Create `src/commands/analyze.ts`:
```typescript
import type { Config } from '../config.js';
import { PolymarketClient } from '../api/client.js';
import { TradeFetcher } from '../api/trades.js';
import { AccountFetcher } from '../api/accounts.js';
import { TradeSizeSignal, AccountHistorySignal, ConvictionSignal, SignalAggregator } from '../signals/index.js';
import type { Trade, SignalContext } from '../signals/types.js';
import type { AnalysisReport, SuspiciousTrade } from '../output/types.js';

export interface AnalyzeOptions {
  marketId: string;
  after?: Date;
  before?: Date;
  outcome?: 'YES' | 'NO';
}

export class AnalyzeCommand {
  private client: PolymarketClient;
  private tradeFetcher: TradeFetcher;
  private accountFetcher: AccountFetcher;
  private signals: [TradeSizeSignal, AccountHistorySignal, ConvictionSignal];
  private aggregator: SignalAggregator;

  constructor(private config: Config) {
    this.client = new PolymarketClient();
    this.tradeFetcher = new TradeFetcher();
    this.accountFetcher = new AccountFetcher();
    this.signals = [
      new TradeSizeSignal(),
      new AccountHistorySignal(),
      new ConvictionSignal(),
    ];
    this.aggregator = new SignalAggregator(config);
  }

  async execute(options: AnalyzeOptions): Promise<AnalysisReport> {
    // 1. Fetch market metadata
    const market = await this.client.getMarket(options.marketId);

    // 2. Fetch all trades
    const allTrades = await this.tradeFetcher.getTradesForMarket(options.marketId, {
      after: options.after,
      before: options.before,
    });

    // 3. Filter to winning side
    const winningTrades = allTrades.filter(t =>
      t.outcome === market.winningOutcome?.toUpperCase()
    );

    // 4. Score each trade
    const scoredTrades: SuspiciousTrade[] = [];

    for (const trade of winningTrades) {
      // Quick score first (without account history)
      const quickContext: SignalContext = { config: this.config };
      const quickResults = await Promise.all(
        this.signals.map(s => s.calculate(trade, quickContext))
      );
      const quickScore = this.aggregator.aggregate(quickResults);

      // Only fetch account history for promising scores
      let accountHistory;
      if (quickScore.total > 50) {
        accountHistory = await this.accountFetcher.getAccountHistory(trade.wallet);
      }

      // Final score with all context
      const fullContext: SignalContext = {
        config: this.config,
        accountHistory,
      };
      const fullResults = await Promise.all(
        this.signals.map(s => s.calculate(trade, fullContext))
      );
      const finalScore = this.aggregator.aggregate(fullResults);

      if (finalScore.isAlert) {
        scoredTrades.push({
          trade,
          score: finalScore,
          accountHistory,
        });
      }
    }

    // 5. Sort by score descending
    scoredTrades.sort((a, b) => b.score.total - a.score.total);

    return {
      market,
      totalTrades: allTrades.length,
      winningTrades: winningTrades.length,
      suspiciousTrades: scoredTrades.slice(0, 10), // Top 10
      analyzedAt: new Date(),
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/commands/analyze.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/analyze.ts tests/commands/analyze.test.ts
git commit -m "feat: implement analyze command for forensic market analysis"
```

---

### Task 13: CLI Entry Point

**Files:**
- Create: `src/index.ts`

**Step 1: Implement CLI entry point**

Create `src/index.ts`:
```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { AnalyzeCommand } from './commands/analyze.js';
import { CLIReporter } from './output/cli.js';

const program = new Command();

program
  .name('polymarket-insider')
  .description('Detect potential insider trading on Polymarket')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyze a market for suspicious trades')
  .requiredOption('-m, --market <id>', 'Market condition ID to analyze')
  .option('--after <date>', 'Only include trades after this date')
  .option('--before <date>', 'Only include trades before this date')
  .option('--outcome <YES|NO>', 'Filter to specific outcome')
  .option('--config <path>', 'Path to config file', './config.json')
  .option('--min-size <usd>', 'Override minimum trade size', parseFloat)
  .option('--threshold <score>', 'Override alert threshold', parseFloat)
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    // Apply CLI overrides
    if (opts.minSize) config.tradeSize.minAbsoluteUsd = opts.minSize;
    if (opts.threshold) config.alertThreshold = opts.threshold;

    const command = new AnalyzeCommand(config);
    const reporter = new CLIReporter();

    try {
      console.log('Fetching market data...\n');

      const report = await command.execute({
        marketId: opts.market,
        after: opts.after ? new Date(opts.after) : undefined,
        before: opts.before ? new Date(opts.before) : undefined,
        outcome: opts.outcome?.toUpperCase() as 'YES' | 'NO' | undefined,
      });

      console.log(reporter.formatAnalysisReport(report));
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
```

**Step 2: Test CLI runs**

Run: `npm run dev -- --help`
Expected: Shows help with `analyze` command

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: implement CLI entry point with analyze command"
```

---

## Phase 7: Integration Testing

### Task 14: Create Test Fixtures

**Files:**
- Create: `tests/fixtures/venezuela-market.json`

**Step 1: Create fixture from known insider case**

Create `tests/fixtures/venezuela-market.json`:
```json
{
  "market": {
    "conditionId": "0x123abc",
    "question": "Will US bomb Venezuela by Feb 2025?",
    "outcomes": ["Yes", "No"],
    "resolved": true,
    "winningOutcome": "Yes"
  },
  "trades": [
    {
      "id": "insider-trade-1",
      "wallet": "0xsuspicious1",
      "side": "BUY",
      "outcome": "YES",
      "size": 100000,
      "price": 0.12,
      "timestamp": "2024-01-15T10:00:00Z",
      "valueUsd": 12000
    },
    {
      "id": "normal-trade-1",
      "wallet": "0xnormal1",
      "side": "BUY",
      "outcome": "YES",
      "size": 500,
      "price": 0.15,
      "timestamp": "2024-01-15T11:00:00Z",
      "valueUsd": 75
    }
  ],
  "accounts": {
    "0xsuspicious1": {
      "totalTrades": 3,
      "firstTradeDate": "2024-01-13T00:00:00Z",
      "lastTradeDate": "2024-01-15T10:00:00Z",
      "totalVolumeUsd": 12500
    },
    "0xnormal1": {
      "totalTrades": 250,
      "firstTradeDate": "2023-01-01T00:00:00Z",
      "lastTradeDate": "2024-01-15T11:00:00Z",
      "totalVolumeUsd": 150000
    }
  }
}
```

**Step 2: Write integration test**

Create `tests/integration/analyze.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { AnalyzeCommand } from '../../src/commands/analyze.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/venezuela-market.json', import.meta.url), 'utf-8')
);

// Mock API calls to return fixture data
vi.mock('../../src/api/client.js', () => ({
  PolymarketClient: vi.fn().mockImplementation(() => ({
    getMarket: vi.fn().mockResolvedValue(fixture.market),
  })),
}));

vi.mock('../../src/api/trades.js', () => ({
  TradeFetcher: vi.fn().mockImplementation(() => ({
    getTradesForMarket: vi.fn().mockResolvedValue(
      fixture.trades.map((t: Record<string, unknown>) => ({
        ...t,
        timestamp: new Date(t.timestamp as string),
        marketId: fixture.market.conditionId,
      }))
    ),
  })),
}));

vi.mock('../../src/api/accounts.js', () => ({
  AccountFetcher: vi.fn().mockImplementation(() => ({
    getAccountHistory: vi.fn().mockImplementation((wallet: string) => {
      const acc = fixture.accounts[wallet];
      return Promise.resolve({
        wallet,
        totalTrades: acc?.totalTrades ?? 0,
        firstTradeDate: acc?.firstTradeDate ? new Date(acc.firstTradeDate) : null,
        lastTradeDate: acc?.lastTradeDate ? new Date(acc.lastTradeDate) : null,
        totalVolumeUsd: acc?.totalVolumeUsd ?? 0,
      });
    }),
  })),
}));

describe('Analyze Integration', () => {
  let command: AnalyzeCommand;

  beforeEach(() => {
    command = new AnalyzeCommand(DEFAULT_CONFIG);
  });

  it('detects known insider trade from Venezuela market', async () => {
    const report = await command.execute({ marketId: fixture.market.conditionId });

    // Should flag the suspicious wallet
    const suspicious = report.suspiciousTrades.find(
      st => st.trade.wallet === '0xsuspicious1'
    );

    expect(suspicious).toBeDefined();
    expect(suspicious!.score.total).toBeGreaterThan(70);
  });

  it('does not flag normal trading activity', async () => {
    const report = await command.execute({ marketId: fixture.market.conditionId });

    // Normal wallet should not be in suspicious list (or have low score)
    const normal = report.suspiciousTrades.find(
      st => st.trade.wallet === '0xnormal1'
    );

    if (normal) {
      expect(normal.score.total).toBeLessThan(50);
    }
  });
});
```

**Step 3: Run integration tests**

Run: `npm test -- tests/integration/analyze.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add tests/fixtures/venezuela-market.json tests/integration/analyze.test.ts
git commit -m "test: add integration tests with Venezuela market fixture"
```

---

### Task 15: Run Full Test Suite

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 2: Build project**

Run: `npm run build`
Expected: Compiles without errors

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: phase 1 complete - forensic analysis MVP"
```

---

## Summary

This plan implements Phase 1 (Forensic Analysis MVP) with:

- **15 tasks** broken into bite-sized TDD steps
- **Configuration system** with sensible defaults and CLI overrides
- **Three detection signals**: Trade Size, Account History, Conviction
- **Signal aggregator** for weighted scoring
- **API layer** for fetching markets, trades, and account histories
- **CLI reporter** with colored output
- **Analyze command** for forensic market analysis
- **Integration tests** with real-world fixture data

Phase 2 (Real-Time Monitoring) can be added after validating detection logic on known insider cases.
