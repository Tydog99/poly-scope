import type { Trade } from '../signals/types.js';
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

export class TradeFetcher {
  private cache: TradeCache;

  constructor(cache?: TradeCache) {
    this.cache = cache ?? new TradeCache();
  }

  async getTradesForMarket(
    marketId: string,
    options: {
      after?: Date;
      before?: Date;
      outcome?: 'YES' | 'NO';
      maxTrades?: number; // Limit initial fetch to this many trades
    } = {}
  ): Promise<Trade[]> {
    // Load cached data
    const cached = this.cache.load(marketId);

    // Fetch new trades (limit to maxTrades if no cache)
    const maxTrades = options.maxTrades ?? 10000; // Default 10k trades
    const newTrades = await this.fetchNewTrades(
      marketId,
      cached?.newestTimestamp ?? 0,
      cached ? undefined : maxTrades
    );

    // Merge new trades with cache
    let allTrades: Trade[];
    if (newTrades.length > 0) {
      const merged = this.cache.merge(marketId, newTrades);
      allTrades = merged.trades;
      console.log(`Fetched ${newTrades.length} new trades, total cached: ${allTrades.length}`);
    } else if (cached) {
      allTrades = cached.trades;
      console.log(`Using ${allTrades.length} cached trades (no new trades)`);
    } else {
      allTrades = [];
      console.log('No trades found');
    }

    // Apply filters
    let result = allTrades;

    if (options.after) {
      result = result.filter(t => t.timestamp >= options.after!);
    }
    if (options.before) {
      result = result.filter(t => t.timestamp <= options.before!);
    }
    if (options.outcome) {
      result = result.filter(t => t.outcome === options.outcome);
    }

    return result;
  }

  private async fetchNewTrades(
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

      const rawTrades = await response.json() as DataApiTrade[];

      if (rawTrades.length === 0) break;

      let foundOld = false;
      for (const raw of rawTrades) {
        // API returns newest first, so if we hit a cached trade, stop
        if (raw.timestamp <= afterTimestamp) {
          foundOld = true;
          break;
        }
        trades.push(this.convertTrade(raw, marketId));

        // Check if we've hit the max trades limit
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

  private convertTrade(raw: DataApiTrade, marketId: string): Trade {
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
