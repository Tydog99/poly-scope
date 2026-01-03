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
