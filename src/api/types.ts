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

export interface SubgraphRedemption {
  id: string;
  timestamp: number;
  payout: string; // BigInt as string, 6 decimals
  conditionId: string;
}

// Aggregated trade types

export interface TradeFill {
  id: string;              // Original fill ID (txHash-logIndex)
  size: number;            // Shares in this fill
  price: number;           // Price for this fill
  valueUsd: number;        // USD value of this fill
  timestamp: number;       // Unix timestamp
  maker?: string;
  taker?: string;
  role?: 'maker' | 'taker';
}

export interface AggregatedTrade {
  // Identity
  transactionHash: string;  // Primary key for aggregation
  marketId: string;         // Token ID (for subgraph) or condition ID
  wallet: string;           // The wallet we're analyzing

  // Aggregated values
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  totalSize: number;        // Sum of shares across fills
  totalValueUsd: number;    // Sum of USD value
  avgPrice: number;         // Weighted average price
  timestamp: Date;          // Earliest fill timestamp

  // Fill details (preserved for debugging/UI)
  fills: TradeFill[];
  fillCount: number;

  // Complementary trade metadata (optional, for UI info)
  hadComplementaryFills?: boolean;
  complementaryValueUsd?: number;
}
