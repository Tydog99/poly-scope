import type { Trade } from '../signals/types.js';
import type { Market, SubgraphTrade } from './types.js';
import type { SubgraphClient, TradeQueryOptions } from './subgraph.js';
import { TradeCache } from './cache.js';

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
  cache?: TradeCache;
}

export interface GetTradesOptions {
  market?: Market; // Required for subgraph (has token IDs)
  after?: Date;
  before?: Date;
  outcome?: 'YES' | 'NO';
  maxTrades?: number;
  allowDataApiFallback?: boolean; // Default true - set false to use subgraph only
}

export class TradeFetcher {
  private cache: TradeCache;
  private subgraphClient: SubgraphClient | null;

  constructor(options: TradeFetcherOptions = {}) {
    this.cache = options.cache ?? new TradeCache();
    this.subgraphClient = options.subgraphClient ?? null;
  }

  async getTradesForMarket(
    marketId: string,
    options: GetTradesOptions = {}
  ): Promise<Trade[]> {
    const maxTrades = options.maxTrades ?? 10000;

    // Load cached data
    const cached = this.cache.load(marketId);

    // Try subgraph first if available AND we have token IDs
    if (this.subgraphClient && options.market?.tokens?.length) {
      try {
        const trades = await this.fetchFromSubgraph(marketId, options);
        if (trades.length > 0) {
          // Merge with cache
          const merged = this.cache.merge(marketId, trades);
          return this.applyFilters(merged.trades, options);
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
    return this.fetchFromDataApi(marketId, options, maxTrades, cached);
  }

  /**
   * Fetch trades from Data API
   */
  private async fetchFromDataApi(
    marketId: string,
    options: GetTradesOptions,
    maxTrades: number,
    cached: { newestTimestamp: number; trades: Trade[] } | null
  ): Promise<Trade[]> {
    const newTrades = await this.fetchNewTradesFromDataApi(
      marketId,
      cached?.newestTimestamp ?? 0,
      cached ? undefined : maxTrades
    );

    let allTrades: Trade[];
    let currentCount: number;

    if (newTrades.length > 0) {
      const merged = this.cache.merge(marketId, newTrades);
      allTrades = merged.trades;
      currentCount = allTrades.length;
      console.log(`Fetched ${newTrades.length} new trades from Data API, total cached: ${currentCount}`);
    } else if (cached) {
      allTrades = cached.trades;
      currentCount = allTrades.length;
      console.log(`Using ${currentCount} cached trades (no new trades)`);
    } else {
      allTrades = [];
      currentCount = 0;
      console.log('No trades found');
    }

    // Backfill older trades if needed
    if (currentCount > 0 && currentCount < maxTrades) {
      const needed = maxTrades - currentCount;
      console.log(`Backfilling ${needed} older trades...`);
      const olderTrades = await this.fetchOlderTradesFromDataApi(marketId, currentCount, needed);
      if (olderTrades.length > 0) {
        const merged = this.cache.merge(marketId, olderTrades);
        allTrades = merged.trades;
        console.log(`Fetched ${olderTrades.length} older trades, total cached: ${allTrades.length}`);
      }
    }

    return this.applyFilters(allTrades, options);
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

    // Convert to Trade type
    return limitedTrades.map((st) => this.convertSubgraphTrade(st, marketId, tokenToOutcome));
  }

  /**
   * Convert a subgraph trade to our internal Trade type
   */
  private convertSubgraphTrade(
    st: SubgraphTrade,
    conditionId: string,
    tokenToOutcome: Map<string, 'YES' | 'NO'>
  ): Trade {
    // In subgraph: size is USD value (6 decimals), price is already a decimal string
    const valueUsd = parseFloat(st.size) / 1e6;
    const price = parseFloat(st.price); // Already 0-1 range, not 6 decimals
    // Calculate number of shares from USD value and price
    const size = price > 0 ? valueUsd / price : 0;

    // Determine outcome from token ID
    const outcome = tokenToOutcome.get(st.marketId.toLowerCase()) ?? 'YES';

    // The taker is the one initiating the trade (who we're analyzing)
    // Side represents the taker's action (Buy = buying from maker's sell order)
    const wallet = st.taker || st.maker;
    const side = st.side === 'Buy' ? 'BUY' : 'SELL';

    return {
      id: st.transactionHash,
      marketId: conditionId,
      wallet,
      side: side as 'BUY' | 'SELL',
      outcome,
      size,
      price,
      timestamp: new Date(st.timestamp * 1000),
      valueUsd,
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

  private async fetchNewTradesFromDataApi(
    marketId: string,
    afterTimestamp: number,
    maxTrades?: number
  ): Promise<Trade[]> {
    const trades: Trade[] = [];
    let offset = 0;
    const limit = 500;

    while (true) {
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

      let foundOld = false;
      for (const raw of rawTrades) {
        if (raw.timestamp <= afterTimestamp) {
          foundOld = true;
          break;
        }
        trades.push(this.convertDataApiTrade(raw, marketId));

        if (maxTrades && trades.length >= maxTrades) {
          console.log(`Reached max trades limit (${maxTrades})`);
          return trades;
        }
      }

      if (foundOld) break;
      if (rawTrades.length < limit) break;

      offset += limit;
      console.log(`Fetching page ${offset / limit + 1}... (${trades.length} trades)`);
    }

    return trades;
  }

  private async fetchOlderTradesFromDataApi(
    marketId: string,
    startOffset: number,
    maxTrades: number
  ): Promise<Trade[]> {
    const trades: Trade[] = [];
    let offset = startOffset;
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
          console.log(`Reached backfill limit (${maxTrades})`);
          return trades;
        }
      }

      if (rawTrades.length < limit) break;

      offset += limit;
      console.log(
        `Backfilling page ${Math.floor((offset - startOffset) / limit) + 1}... (${trades.length} older trades)`
      );
    }

    return trades;
  }

  private convertDataApiTrade(raw: DataApiTrade, marketId: string): Trade {
    const size = typeof raw.size === 'string' ? parseFloat(raw.size) : raw.size;
    const price = typeof raw.price === 'string' ? parseFloat(raw.price) : raw.price;

    return {
      id: raw.transactionHash,
      marketId,
      wallet: raw.proxyWallet,
      side: raw.side,
      outcome: raw.outcome.toUpperCase() as 'YES' | 'NO',
      size,
      price,
      timestamp: new Date(raw.timestamp * 1000),
      valueUsd: size * price,
    };
  }
}
