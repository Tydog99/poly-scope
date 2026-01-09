import type { AggregatedTrade } from '../api/types.js';

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
  calculate(trade: AggregatedTrade, context: SignalContext): Promise<SignalResult>;
}

export interface SignalContext {
  config: import('../config.js').Config;
  accountHistory?: AccountHistory;
  marketPrices?: PricePoint[];
  // Point-in-time historical state (optional, from DB)
  historicalState?: {
    tradeCount: number;
    volume: number;
    pnl: number;
    approximate: boolean;
  };
}

// Re-export AggregatedTrade as Trade for backward compatibility during migration
// TODO: Remove this alias after all consumers are updated
export type Trade = AggregatedTrade;

export interface AccountHistory {
  wallet: string;
  totalTrades: number;
  firstTradeDate: Date | null;
  lastTradeDate: Date | null;
  totalVolumeUsd: number;
  // Enhanced fields from subgraph (optional for backward compatibility)
  creationDate?: Date; // True account creation from blockchain
  profitUsd?: number; // Lifetime P&L (trading + redemptions)
  tradingProfitUsd?: number; // valueSold - valueBought (before redemptions)
  redemptionPayoutsUsd?: number; // Total payouts from resolved winning positions
  dataSource?: 'data-api' | 'subgraph' | 'subgraph-trades' | 'subgraph-estimated' | 'cache';
}

export interface PricePoint {
  timestamp: Date;
  price: number;
}
