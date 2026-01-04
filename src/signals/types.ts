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
  // Enhanced fields from subgraph (optional for backward compatibility)
  creationDate?: Date; // True account creation from blockchain
  profitUsd?: number; // Lifetime P&L
  dataSource?: 'data-api' | 'subgraph';
}

export interface PricePoint {
  timestamp: Date;
  price: number;
}
