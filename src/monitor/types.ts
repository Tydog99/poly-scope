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
