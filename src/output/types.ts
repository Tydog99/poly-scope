import type { AggregatedTrade } from '../api/types.js';
import type { AggregatedScore, AccountHistory } from '../signals/types.js';
import type { Market } from '../api/types.js';

export interface SuspiciousTrade {
  trade: AggregatedTrade;
  score: AggregatedScore;
  accountHistory?: AccountHistory;
  priceImpact?: {
    before: number;
    after: number;
    changePercent: number;
  };
  classifications?: string[];
}

export interface AnalysisReport {
  market: Market;
  totalTrades: number;
  analyzedTrades: number;
  suspiciousTrades: SuspiciousTrade[];
  analyzedAt: Date;
  targetWallet?: string;
  targetAccountHistory?: AccountHistory;
}
