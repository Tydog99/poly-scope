import { readFileSync, existsSync } from 'fs';

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
  classification: {
    whaleThreshold: number;
    sniperSizeMax: number;
    sniperImpactMin: number;
    sniperScoreMin: number;
    earlyWindowHours: number;
    dumpImpactMin: number;
  };
  filters: {
    excludeSafeBets: boolean;
    safeBetThreshold: number;
  };
  subgraph: {
    enabled: boolean;
    timeout: number;
    retries: number;
    cacheAccountLookup?: boolean;
  };
  /**
   * Filter trades by participant role to avoid double-counting.
   * - 'taker': Only taker trades (default, recommended for insider detection)
   * - 'maker': Only maker trades
   * - 'both': Include both (may double-count volume)
   */
  tradeRole: 'taker' | 'maker' | 'both';
  alertThreshold: number;
  watchlist: string[];
  monitor: MonitorConfig;
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
  classification: {
    whaleThreshold: 25000,
    sniperSizeMax: 10000,
    sniperImpactMin: 2.0,
    sniperScoreMin: 80,
    earlyWindowHours: 48,
    dumpImpactMin: 5.0,
  },
  filters: {
    excludeSafeBets: true,
    safeBetThreshold: 0.95,
  },
  subgraph: {
    enabled: true,
    timeout: 30000,
    retries: 2,
    cacheAccountLookup: true, // Cache account data to resume on failure
  },
  tradeRole: 'taker', // Default to taker-only to avoid double-counting
  alertThreshold: 70,
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
    classification: { ...DEFAULT_CONFIG.classification, ...userConfig.classification },
    filters: { ...DEFAULT_CONFIG.filters, ...userConfig.filters },
    subgraph: { ...DEFAULT_CONFIG.subgraph, ...userConfig.subgraph },
    monitor: {
      ...DEFAULT_CONFIG.monitor,
      ...userConfig.monitor,
      backoff: { ...DEFAULT_CONFIG.monitor.backoff, ...userConfig.monitor?.backoff },
    },
  };
}
