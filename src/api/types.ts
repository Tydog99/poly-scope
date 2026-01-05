export interface MarketToken {
  tokenId: string;
  outcome: 'Yes' | 'No';
  price?: number;
}

export interface Market {
  conditionId: string;
  questionId: string;
  question: string;
  outcomes: string[];
  tokens: MarketToken[]; // YES and NO token IDs
  resolutionSource: string;
  endDate: string;
  resolved: boolean;
  winningOutcome?: string;
  createdAt?: string;
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

export interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  outcomes: string[];
  outcomePrices: string;
  volume: string;
  active: boolean;
  closed: boolean;
}

export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  markets: GammaMarket[];
}

// The Graph Subgraph types

export interface SubgraphAccount {
  id: string;
  creationTimestamp: number;
  lastSeenTimestamp: number;
  collateralVolume: string; // BigInt as string, 6 decimals
  numTrades: number;
  profit: string; // BigInt as string, 6 decimals, can be negative
  scaledProfit: string;
}

export interface SubgraphTrade {
  id: string;
  transactionHash: string;
  timestamp: number;
  maker: string;
  taker: string;
  marketId: string; // Token ID / Orderbook ID
  side: 'Buy' | 'Sell';
  size: string; // BigInt as string, 6 decimals
  price: string; // BigInt as string, 6 decimals
}

export interface SubgraphPosition {
  id: string;
  marketId: string;
  valueBought: string;
  valueSold: string;
  netValue: string;
  quantityBought: string;
  quantitySold: string;
  netQuantity: string;
}
