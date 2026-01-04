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
