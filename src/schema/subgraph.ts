/**
 * Polymarket Subgraph Schema Types
 *
 * Auto-generated from subgraph introspection.
 * Subgraph ID: 81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC
 *
 * GraphQL scalar mappings:
 * - ID, String, Bytes -> string
 * - Int -> number
 * - BigInt, BigDecimal -> string (preserved as strings for precision)
 * - Boolean -> boolean
 */

// =============================================================================
// Enums
// =============================================================================

export type TradeType = 'Buy' | 'Sell';

// =============================================================================
// Core Entities
// =============================================================================

/**
 * Account - Aggregated user stats across all markets
 */
export interface Account {
  id: string;
  creationTimestamp: string;
  lastSeenTimestamp: string;
  collateralVolume: string;
  numTrades: string;
  scaledCollateralVolume: string;
  lastTradedTimestamp: string;
  profit: string;
  scaledProfit: string;
  // Relations (not always fetched)
  fpmmPoolMemberships?: FpmmPoolMembership[];
  marketPositions?: MarketPosition[];
  transactions?: Transaction[];
  splits?: Split[];
  merges?: Merge[];
  redemptions?: Redemption[];
  marketProfits?: MarketProfit[];
}

/**
 * Condition - A prediction market condition with outcomes
 */
export interface Condition {
  id: string;
  oracle: string;
  questionId: string;
  outcomeSlotCount: number;
  resolutionTimestamp: string | null;
  payouts: string[] | null;
  payoutNumerators: string[] | null;
  payoutDenominator: string | null;
  resolutionHash: string | null;
  // Relations
  fixedProductMarketMakers?: FixedProductMarketMaker[];
}

/**
 * Collateral - Token used as collateral (USDC)
 */
export interface Collateral {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
}

// =============================================================================
// Trade Entities
// =============================================================================

/**
 * EnrichedOrderFilled - Trade event with maker/taker/market references
 *
 * This is the PRIMARY entity we use for fetching trades.
 * It enriches raw order fills with account and orderbook references.
 */
export interface EnrichedOrderFilled {
  id: string;
  transactionHash: string;
  timestamp: string;
  orderHash: string;
  side: TradeType;
  size: string; // 6 decimals
  price: string; // 6 decimals
  // Relations
  maker: Account;
  taker: Account;
  market: Orderbook;
}

/**
 * OrderFilledEvent - Raw order fill event (lower level than EnrichedOrderFilled)
 */
export interface OrderFilledEvent {
  id: string;
  transactionHash: string;
  timestamp: string;
  orderHash: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: string;
  takerAmountFilled: string;
  fee: string;
  // Relations
  maker: Account;
  taker: Account;
}

/**
 * OrdersMatchedEvent - Order matching event (minimal info)
 */
export interface OrdersMatchedEvent {
  id: string;
  timestamp: string;
  makerAssetID: string;
  takerAssetID: string;
  makerAmountFilled: string;
  takerAmountFilled: string;
}

/**
 * Orderbook - Per-token trade aggregates
 */
export interface Orderbook {
  id: string;
  tradesQuantity: string;
  buysQuantity: string;
  sellsQuantity: string;
  collateralVolume: string;
  scaledCollateralVolume: string;
  collateralBuyVolume: string;
  scaledCollateralBuyVolume: string;
  collateralSellVolume: string;
  scaledCollateralSellVolume: string;
  lastActiveDay: string;
}

/**
 * Transaction - AMM (FPMM) trade transaction
 */
export interface Transaction {
  id: string;
  type: TradeType;
  timestamp: string;
  tradeAmount: string;
  feeAmount: string;
  outcomeIndex: string;
  outcomeTokensAmount: string;
  // Relations
  market: FixedProductMarketMaker;
  user: Account;
}

// =============================================================================
// Position Entities
// =============================================================================

/**
 * MarketPosition - User's position in a specific market outcome
 */
export interface MarketPosition {
  id: string;
  quantityBought: string;
  quantitySold: string;
  netQuantity: string;
  valueBought: string;
  valueSold: string;
  netValue: string;
  feesPaid: string;
  // Relations
  market: MarketData;
  user: Account;
}

/**
 * MarketData - Links condition outcome to market maker
 */
export interface MarketData {
  id: string;
  outcomeIndex: string;
  priceOrderbook: string;
  // Relations
  condition: Condition;
  fpmm: FixedProductMarketMaker;
}

/**
 * MarketProfit - User's realized profit per condition
 */
export interface MarketProfit {
  id: string;
  profit: string;
  scaledProfit: string;
  // Relations
  user: Account;
  condition: Condition;
}

// =============================================================================
// AMM (FPMM) Entities
// =============================================================================

/**
 * FixedProductMarketMaker - AMM pool for a condition
 */
export interface FixedProductMarketMaker {
  id: string;
  creator: string;
  creationTimestamp: string;
  creationTransactionHash: string;
  conditionalTokenAddress: string;
  fee: string;
  tradesQuantity: string;
  buysQuantity: string;
  sellsQuantity: string;
  liquidityAddQuantity: string;
  liquidityRemoveQuantity: string;
  collateralVolume: string;
  scaledCollateralVolume: string;
  collateralBuyVolume: string;
  scaledCollateralBuyVolume: string;
  collateralSellVolume: string;
  scaledCollateralSellVolume: string;
  feeVolume: string;
  scaledFeeVolume: string;
  liquidityParameter: string;
  scaledLiquidityParameter: string;
  outcomeTokenAmounts: string[];
  outcomeTokenPrices: string[];
  outcomeSlotCount: number;
  lastActiveDay: string;
  totalSupply: string;
  // Relations
  collateralToken: Collateral;
  conditions: Condition[];
  poolMembers?: FpmmPoolMembership[];
}

/**
 * FpmmFundingAddition - Liquidity addition to AMM
 */
export interface FpmmFundingAddition {
  id: string;
  timestamp: string;
  amountsAdded: string[];
  amountsRefunded: string[];
  sharesMinted: string;
  // Relations
  fpmm: FixedProductMarketMaker;
  funder: Account;
}

/**
 * FpmmFundingRemoval - Liquidity removal from AMM
 */
export interface FpmmFundingRemoval {
  id: string;
  timestamp: string;
  amountsRemoved: string[];
  collateralRemoved: string;
  sharesBurnt: string;
  // Relations
  fpmm: FixedProductMarketMaker;
  funder: Account;
}

/**
 * FpmmPoolMembership - User's LP position in AMM
 */
export interface FpmmPoolMembership {
  id: string;
  amount: string;
  // Relations
  pool: FixedProductMarketMaker;
  funder: Account;
}

// =============================================================================
// Token Operation Entities
// =============================================================================

/**
 * Split - Collateral split into outcome tokens
 */
export interface Split {
  id: string;
  timestamp: string;
  parentCollectionId: string;
  partition: string[];
  amount: string;
  // Relations
  stakeholder: Account;
  collateralToken: Collateral;
  condition: Condition;
}

/**
 * Merge - Outcome tokens merged back to collateral
 */
export interface Merge {
  id: string;
  timestamp: string;
  parentCollectionId: string;
  partition: string[];
  amount: string;
  // Relations
  stakeholder: Account;
  collateralToken: Collateral;
  condition: Condition;
}

/**
 * Redemption - Winning outcome tokens redeemed for collateral
 */
export interface Redemption {
  id: string;
  timestamp: string;
  parentCollectionId: string;
  indexSets: string[];
  payout: string;
  // Relations
  redeemer: Account;
  collateralToken: Collateral;
  condition: Condition;
}

// =============================================================================
// Global Aggregates
// =============================================================================

/**
 * Global - Platform-wide aggregates
 */
export interface Global {
  id: string;
  numConditions: number;
  numOpenConditions: number;
  numClosedConditions: number;
  numTraders: string;
  tradesQuantity: string;
  buysQuantity: string;
  sellsQuantity: string;
  collateralVolume: string;
  scaledCollateralVolume: string;
  collateralFees: string;
  scaledCollateralFees: string;
  collateralBuyVolume: string;
  scaledCollateralBuyVolume: string;
  collateralSellVolume: string;
  scaledCollateralSellVolume: string;
}

/**
 * OrdersMatchedGlobal - Global order matching aggregates
 */
export interface OrdersMatchedGlobal {
  id: string;
  tradesQuantity: string;
  buysQuantity: string;
  sellsQuantity: string;
  collateralVolume: string;
  scaledCollateralVolume: string;
  collateralBuyVolume: string;
  scaledCollateralBuyVolume: string;
  collateralSellVolume: string;
  scaledCollateralSellVolume: string;
}

// =============================================================================
// Block Metadata
// =============================================================================

/**
 * _Block_ - Block info from indexer
 */
export interface Block {
  hash: string;
  number: number;
  timestamp: number;
  parentHash: string;
}

/**
 * _Meta_ - Subgraph deployment metadata
 */
export interface Meta {
  block: Block;
  deployment: string;
  hasIndexingErrors: boolean;
}
