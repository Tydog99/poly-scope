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
  subgraph: {
    enabled: boolean;
    timeout: number;
    retries: number;
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
  subgraph: {
    enabled: true,
    timeout: 30000,
    retries: 2,
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
    subgraph: { ...DEFAULT_CONFIG.subgraph, ...userConfig.subgraph },
  };
}
