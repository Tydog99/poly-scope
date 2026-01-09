import type { Trade } from '../signals/types.js';
import type { Market, SubgraphTrade } from './types.js';
import type { SubgraphClient, TradeQueryOptions } from './subgraph.js';

const DATA_API = 'https://data-api.polymarket.com';

interface DataApiTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  size: string | number;
  price: string | number;
  timestamp: number;
  conditionId: string;
  outcome: string;
  transactionHash: string;
}

export interface TradeFetcherOptions {
  subgraphClient?: SubgraphClient | null;
}

export interface GetTradesOptions {
  market?: Market; // Required for subgraph (has token IDs)
  after?: Date;
  before?: Date;
  outcome?: 'YES' | 'NO';
  maxTrades?: number;
  allowDataApiFallback?: boolean; // Default true - set false to use subgraph only
  /**
   * Filter trades by participant role to avoid double-counting.
   * - 'taker': Only trades where the wallet is the taker (default, recommended for insider detection)
   * - 'maker': Only trades where the wallet is the maker
   * - 'both': Include both maker and taker trades (may double-count volume)
   * See: https://www.paradigm.xyz/2025/12/polymarket-volume-is-being-double-counted
   */
  role?: 'taker' | 'maker' | 'both';
}

export class TradeFetcher {
  private subgraphClient: SubgraphClient | null;

  constructor(options: TradeFetcherOptions = {}) {
    this.subgraphClient = options.subgraphClient ?? null;
  }

  async getTradesForMarket(
    marketId: string,
    options: GetTradesOptions = {}
  ): Promise<Trade[]> {
    const maxTrades = options.maxTrades ?? 10000;

    // Try subgraph first if available AND we have token IDs
    if (this.subgraphClient && options.market?.tokens?.length) {
      try {
        const trades = await this.fetchFromSubgraph(marketId, options);

        if (trades.length > 0) {
          console.log(`Fetched ${trades.length} trades from subgraph`);
          return this.applyFilters(trades, options);
        }

        // No trades from subgraph - could be empty market or issue
        if (options.allowDataApiFallback === false) {
          console.log('Subgraph returned no trades');
          return [];
        }
        console.log('Subgraph returned no trades, falling back to Data API');
      } catch (error) {
        if (options.allowDataApiFallback === false) {
          throw error; // Don't fall back if explicitly disabled
        }
        console.log(`Subgraph error, falling back to Data API: ${error}`);
      }
    }

    // Fall back to Data API
    return this.fetchFromDataApi(marketId, options, maxTrades);
  }

  /**
   * Fetch trades from Data API
   */
  private async fetchFromDataApi(
    marketId: string,
    options: GetTradesOptions,
    maxTrades: number
  ): Promise<Trade[]> {
    const trades = await this.fetchTradesFromDataApi(marketId, maxTrades);

    if (trades.length > 0) {
      console.log(`Fetched ${trades.length} trades from Data API`);
    } else {
      console.log('No trades found');
    }

    return this.applyFilters(trades, options);
  }

  /**
   * Fetch trades from The Graph subgraph using token IDs
   */
  private async fetchFromSubgraph(
    marketId: string,
    options: GetTradesOptions
  ): Promise<Trade[]> {
    if (!this.subgraphClient || !options.market?.tokens?.length) {
      return [];
    }

    const totalLimit = options.maxTrades ?? 10000;
    const numTokens = options.market.tokens.length;
    const perTokenLimit = Math.ceil(totalLimit / numTokens);

    const queryOptions: TradeQueryOptions = {
      limit: perTokenLimit,
      after: options.after,
      before: options.before,
      orderDirection: 'desc',
    };

    // Build token ID to outcome mapping
    const tokenToOutcome = new Map<string, 'YES' | 'NO'>();
    for (const token of options.market.tokens) {
      tokenToOutcome.set(token.tokenId.toLowerCase(), token.outcome.toUpperCase() as 'YES' | 'NO');
    }

    // Fetch trades for each token
    const allSubgraphTrades: SubgraphTrade[] = [];
    for (const token of options.market.tokens) {
      console.log(`Fetching trades for ${token.outcome} token (${token.tokenId.slice(0, 10)}...)...`);
      const trades = await this.subgraphClient.getTradesByMarket(token.tokenId, queryOptions);
      allSubgraphTrades.push(...trades);
    }

    console.log(`Fetched ${allSubgraphTrades.length} trades from subgraph`);

    // Sort by timestamp descending and limit to total
    allSubgraphTrades.sort((a, b) => b.timestamp - a.timestamp);
    const limitedTrades = allSubgraphTrades.slice(0, totalLimit);

    // Convert to Trade type with role filtering (default: taker-only to avoid double-counting)
    const roleFilter = options.role ?? 'taker';
    const trades = limitedTrades
      .map((st) => this.convertSubgraphTrade(st, marketId, tokenToOutcome, roleFilter))
      .filter((t): t is Trade => t !== null);

    return trades;
  }

  /**
   * Convert a subgraph trade to our internal Trade type.
   *
   * IMPORTANT: The `side` field in EnrichedOrderFilled is the MAKER's order side,
   * not the taker's action. To interpret correctly:
   * - If wallet is maker: side is correct as-is
   * - If wallet is taker: side must be INVERTED (taker fills opposite side)
   *
   * See: https://yzc.me/x01Crypto/decoding-polymarket
   */
  private convertSubgraphTrade(
    st: SubgraphTrade,
    conditionId: string,
    tokenToOutcome: Map<string, 'YES' | 'NO'>,
    roleFilter: 'taker' | 'maker' | 'both'
  ): Trade | null {
    // In subgraph: size is USD value (6 decimals), price is already a decimal string
    const valueUsd = parseFloat(st.size) / 1e6;
    const price = parseFloat(st.price); // Already 0-1 range, not 6 decimals
    // Calculate number of shares from USD value and price
    const size = price > 0 ? valueUsd / price : 0;

    // Determine outcome from token ID
    const outcome = tokenToOutcome.get(st.marketId.toLowerCase()) ?? 'YES';

    // Determine which wallet to attribute this trade to based on role filter
    let wallet: string;
    let role: 'maker' | 'taker';
    let side: 'BUY' | 'SELL';

    if (roleFilter === 'taker') {
      // Taker-only: skip if no taker
      if (!st.taker) return null;
      wallet = st.taker;
      role = 'taker';
      // Taker's action is OPPOSITE of maker's side field
      // If maker's side is 'Buy', taker is SELLING to the maker
      // If maker's side is 'Sell', taker is BUYING from the maker
      side = st.side === 'Buy' ? 'SELL' : 'BUY';
    } else if (roleFilter === 'maker') {
      // Maker-only: skip if no maker
      if (!st.maker) return null;
      wallet = st.maker;
      role = 'maker';
      // Maker's action matches the side field directly
      side = st.side === 'Buy' ? 'BUY' : 'SELL';
    } else {
      // 'both' - prefer taker (more relevant for insider detection), fall back to maker
      if (st.taker) {
        wallet = st.taker;
        role = 'taker';
        side = st.side === 'Buy' ? 'SELL' : 'BUY';
      } else if (st.maker) {
        wallet = st.maker;
        role = 'maker';
        side = st.side === 'Buy' ? 'BUY' : 'SELL';
      } else {
        return null; // No wallet info
      }
    }

    return {
      transactionHash: st.transactionHash,
      marketId: conditionId,
      wallet,
      side,
      outcome,
      totalSize: size,
      avgPrice: price,
      totalValueUsd: valueUsd,
      timestamp: new Date(st.timestamp * 1000),
      fills: [{
        id: st.id,
        size,
        price,
        valueUsd,
        timestamp: st.timestamp,
        maker: st.maker,
        taker: st.taker,
        role,
      }],
      fillCount: 1,
    };
  }

  private applyFilters(trades: Trade[], options: GetTradesOptions): Trade[] {
    let result = trades;

    if (options.after) {
      result = result.filter((t) => t.timestamp >= options.after!);
    }
    if (options.before) {
      result = result.filter((t) => t.timestamp <= options.before!);
    }
    if (options.outcome) {
      result = result.filter((t) => t.outcome === options.outcome);
    }

    return result;
  }

  // --- Data API methods (fallback) ---

  private async fetchTradesFromDataApi(
    marketId: string,
    maxTrades: number
  ): Promise<Trade[]> {
    const trades: Trade[] = [];
    let offset = 0;
    const limit = 500;

    while (trades.length < maxTrades) {
      const url = new URL(`${DATA_API}/trades`);
      url.searchParams.set('market', marketId);
      url.searchParams.set('limit', limit.toString());
      url.searchParams.set('offset', offset.toString());

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Failed to fetch trades: ${response.statusText}`);
      }

      const rawTrades = (await response.json()) as DataApiTrade[];

      if (rawTrades.length === 0) break;

      for (const raw of rawTrades) {
        trades.push(this.convertDataApiTrade(raw, marketId));
        if (trades.length >= maxTrades) {
          console.log(`Reached max trades limit (${maxTrades})`);
          return trades;
        }
      }

      if (rawTrades.length < limit) break;

      offset += limit;
      console.log(`Fetching page ${offset / limit + 1}... (${trades.length} trades)`);
    }

    return trades;
  }

  private convertDataApiTrade(raw: DataApiTrade, marketId: string): Trade {
    const size = typeof raw.size === 'string' ? parseFloat(raw.size) : raw.size;
    const price = typeof raw.price === 'string' ? parseFloat(raw.price) : raw.price;
    const valueUsd = size * price;

    return {
      transactionHash: raw.transactionHash,
      marketId,
      wallet: raw.proxyWallet,
      side: raw.side,
      outcome: raw.outcome.toUpperCase() as 'YES' | 'NO',
      totalSize: size,
      avgPrice: price,
      totalValueUsd: valueUsd,
      timestamp: new Date(raw.timestamp * 1000),
      fills: [{
        id: raw.transactionHash,
        size,
        price,
        valueUsd,
        timestamp: raw.timestamp,
      }],
      fillCount: 1,
    };
  }
}
