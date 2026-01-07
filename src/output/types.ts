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
  classifications?: string[];
}

export interface AnalysisReport {
  market: Market;
  totalTrades: number;
  analyzedTrades: number;
  suspiciousTrades: SuspiciousTrade[];
  analyzedAt: Date;
  // Wallet mode fields
  targetWallet?: string;
  targetAccountHistory?: import('../signals/types.js').AccountHistory;
}
