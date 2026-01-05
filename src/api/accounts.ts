import type { AccountHistory } from '../signals/types.js';
import type { SubgraphClient } from './subgraph.js';
import { AccountCache } from './account-cache.js';

const DATA_API = 'https://data-api.polymarket.com';

interface DataApiTrade {
  proxyWallet: string;
  size: string;
  price: string;
  timestamp: number;
}

export interface AccountFetcherOptions {
  subgraphClient?: SubgraphClient | null;
  cacheAccountLookup?: boolean;
}

export class AccountFetcher {
  private subgraphClient: SubgraphClient | null;
  private cache: AccountCache;
  private useCache: boolean;

  constructor(options: AccountFetcherOptions = {}) {
    this.subgraphClient = options.subgraphClient || null;
    this.useCache = options.cacheAccountLookup || false;
    this.cache = new AccountCache();
  }

  /**
   * Get account history, preferring subgraph data when available
   */
  async getAccountHistory(wallet: string): Promise<AccountHistory> {
    // Check cache first if enabled
    if (this.useCache) {
      const cached = this.cache.load(wallet);
      if (cached) {
        return { ...cached, dataSource: 'cache' };
      }
    }

    let history: AccountHistory;

    // Try subgraph first for more accurate data
    if (this.subgraphClient) {
      const subgraphHistory = await this.getFromSubgraph(wallet);
      if (subgraphHistory) {
        history = subgraphHistory;
      } else {
        history = await this.getFromDataApi(wallet);
      }
    } else {
      history = await this.getFromDataApi(wallet);
    }

    // Save to cache if enabled
    if (this.useCache) {
      this.cache.save(history);
    }

    return history;
  }

  /**
   * Batch fetch account histories for multiple wallets
   */
  async getAccountHistoryBatch(wallets: string[]): Promise<Map<string, AccountHistory>> {
    const results = new Map<string, AccountHistory>();
    const walletsToFetch: string[] = [];

    // Check cache first
    if (this.useCache) {
      for (const wallet of wallets) {
        const cached = this.cache.load(wallet);
        if (cached) {
          results.set(wallet.toLowerCase(), { ...cached, dataSource: 'cache' });
        } else {
          walletsToFetch.push(wallet);
        }
      }
    } else {
      walletsToFetch.push(...wallets);
    }

    if (walletsToFetch.length === 0) {
      return results;
    }

    // Fetch missing wallets
    if (this.subgraphClient) {
      // Use subgraph batch query
      const accounts = await this.subgraphClient.getAccountBatch(walletsToFetch);
      for (const [wallet, account] of accounts) {
        const history: AccountHistory = {
          wallet: account.id,
          totalTrades: account.numTrades,
          firstTradeDate: new Date(account.creationTimestamp * 1000),
          lastTradeDate: new Date(account.lastSeenTimestamp * 1000),
          totalVolumeUsd: parseFloat(account.collateralVolume) / 1e6,
          creationDate: new Date(account.creationTimestamp * 1000),
          profitUsd: parseFloat(account.profit) / 1e6,
          dataSource: 'subgraph',
        };
        results.set(wallet.toLowerCase(), history);
        if (this.useCache) this.cache.save(history);
      }

      // For wallets not found in subgraph, try Data API
      const missing = walletsToFetch.filter((w) => !results.has(w.toLowerCase()));
      for (const wallet of missing) {
        const history = await this.getFromDataApi(wallet);
        results.set(wallet.toLowerCase(), history);
        if (this.useCache) this.cache.save(history);
      }
    } else {
      // Fall back to sequential Data API calls
      for (const wallet of walletsToFetch) {
        const history = await this.getFromDataApi(wallet);
        results.set(wallet.toLowerCase(), history);
        if (this.useCache) this.cache.save(history);
      }
    }

    return results;
  }

  /**
   * Get account history from The Graph subgraph
   */
  private async getFromSubgraph(wallet: string): Promise<AccountHistory | null> {
    if (!this.subgraphClient) return null;

    try {
      const account = await this.subgraphClient.getAccount(wallet);
      if (!account) {
        // Account not found in subgraph - might be very new or never traded
        return null;
      }

      return {
        wallet: account.id,
        totalTrades: account.numTrades,
        firstTradeDate: new Date(account.creationTimestamp * 1000),
        lastTradeDate: new Date(account.lastSeenTimestamp * 1000),
        totalVolumeUsd: parseFloat(account.collateralVolume) / 1e6,
        creationDate: new Date(account.creationTimestamp * 1000),
        profitUsd: parseFloat(account.profit) / 1e6,
        dataSource: 'subgraph',
      };
    } catch {
      // Subgraph query failed, will fall back to Data API
      return null;
    }
  }

  /**
   * Get account history from Polymarket Data API
   */
  private async getFromDataApi(wallet: string): Promise<AccountHistory> {
    const url = new URL(`${DATA_API}/trades`);
    url.searchParams.set('user', wallet);
    url.searchParams.set('limit', '1000');

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch account history: ${response.statusText}`);
    }

    const trades = (await response.json()) as DataApiTrade[];

    if (trades.length === 0) {
      return {
        wallet,
        totalTrades: 0,
        firstTradeDate: null,
        lastTradeDate: null,
        totalVolumeUsd: 0,
        dataSource: 'data-api',
      };
    }

    const timestamps = trades.map((t) => t.timestamp);
    const volumes = trades.map((t) => parseFloat(t.size) * parseFloat(t.price));

    return {
      wallet,
      totalTrades: trades.length,
      firstTradeDate: new Date(Math.min(...timestamps)),
      lastTradeDate: new Date(Math.max(...timestamps)),
      totalVolumeUsd: volumes.reduce((sum, v) => sum + v, 0),
      dataSource: 'data-api',
    };
  }
}
