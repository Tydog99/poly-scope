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
   * Check if history is already in cache
   */
  isCached(wallet: string): boolean {
    return this.useCache && this.cache.has(wallet);
  }

  /**
   * Get account history, preferring subgraph data when available
   */
  async getAccountHistory(
    wallet: string,
    options: { skipNetwork?: boolean } = {}
  ): Promise<AccountHistory | null> {
    // Check cache first if enabled
    if (this.useCache) {
      const cached = this.cache.load(wallet);
      if (cached) {
        return { ...cached, dataSource: 'cache' };
      }
    }

    if (options.skipNetwork) {
      return null;
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
   * Chunks requests to avoid query complexity limits
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
      // Chunk wallets to avoid query complexity limits (100 per batch)
      const CHUNK_SIZE = 100;
      const chunks: string[][] = [];
      for (let i = 0; i < walletsToFetch.length; i += CHUNK_SIZE) {
        chunks.push(walletsToFetch.slice(i, i + CHUNK_SIZE));
      }

      // Track wallets with broken Account entity data (numTrades=0 but volume>0)
      const brokenAccounts: Array<{
        wallet: string;
        volume: number;
        tradingProfit: number;
        redemptionPayouts: number;
        creationTimestamp: number;
        lastSeenTimestamp: number;
      }> = [];

      // Fetch redemptions for all wallets in batch
      const allRedemptions = await this.subgraphClient.getRedemptionsBatch(walletsToFetch);

      // Process chunks sequentially to avoid rate limiting
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];

        if (chunks.length > 1) {
          console.log(`    Batch ${chunkIdx + 1}/${chunks.length} (${chunk.length} wallets)`);
        }

        const accounts = await this.subgraphClient.getAccountBatch(chunk);
        for (const [wallet, account] of accounts) {
          const totalTrades = account.numTrades;
          const volume = parseFloat(account.collateralVolume) / 1e6;
          const tradingProfit = parseFloat(account.profit) / 1e6;

          // Sum redemption payouts for this wallet
          const walletRedemptions = allRedemptions.get(wallet.toLowerCase()) || [];
          const redemptionPayouts = walletRedemptions.reduce(
            (sum, r) => sum + parseFloat(r.payout) / 1e6,
            0
          );
          const totalProfit = tradingProfit + redemptionPayouts;

          // Detect broken Account entity (numTrades=0 but has volume/profit)
          if (totalTrades === 0 && (Math.abs(volume) > 0 || Math.abs(tradingProfit) > 0.1)) {
            brokenAccounts.push({
              wallet: account.id,
              volume,
              tradingProfit,
              redemptionPayouts,
              creationTimestamp: account.creationTimestamp,
              lastSeenTimestamp: account.lastSeenTimestamp,
            });
            continue;
          }

          const history: AccountHistory = {
            wallet: account.id,
            totalTrades,
            firstTradeDate: new Date(account.creationTimestamp * 1000),
            lastTradeDate: new Date(account.lastSeenTimestamp * 1000),
            totalVolumeUsd: volume,
            creationDate: new Date(account.creationTimestamp * 1000),
            profitUsd: totalProfit,
            tradingProfitUsd: tradingProfit,
            redemptionPayoutsUsd: redemptionPayouts,
            dataSource: 'subgraph',
          };
          results.set(wallet.toLowerCase(), history);
          if (this.useCache) this.cache.save(history);
        }
      }

      // Query actual trade counts for broken accounts
      if (brokenAccounts.length > 0) {
        console.log(`    Querying actual trade counts for ${brokenAccounts.length} broken Account entities...`);
        const tradeCounts = await this.subgraphClient.getTradeCountBatch(
          brokenAccounts.map((a) => a.wallet)
        );

        for (const broken of brokenAccounts) {
          const tradeData = tradeCounts.get(broken.wallet.toLowerCase());
          const actualCount = tradeData?.count ?? 0;
          const totalProfit = broken.tradingProfit + broken.redemptionPayouts;

          const history: AccountHistory = {
            wallet: broken.wallet,
            totalTrades: actualCount,
            firstTradeDate: tradeData?.firstTimestamp
              ? new Date(tradeData.firstTimestamp * 1000)
              : new Date(broken.creationTimestamp * 1000),
            lastTradeDate: tradeData?.lastTimestamp
              ? new Date(tradeData.lastTimestamp * 1000)
              : new Date(broken.lastSeenTimestamp * 1000),
            totalVolumeUsd: broken.volume,
            creationDate: new Date(broken.creationTimestamp * 1000),
            profitUsd: totalProfit,
            tradingProfitUsd: broken.tradingProfit,
            redemptionPayoutsUsd: broken.redemptionPayouts,
            dataSource: 'subgraph-trades',
          };
          results.set(broken.wallet.toLowerCase(), history);
          if (this.useCache) this.cache.save(history);
        }
      }

      // For wallets not found in subgraph, try Data API
      const missing = walletsToFetch.filter((w) => !results.has(w.toLowerCase()));
      if (missing.length > 0) {
        console.log(`    Fetching ${missing.length} missing wallets from Data API...`);
        for (const wallet of missing) {
          const history = await this.getFromDataApi(wallet);
          results.set(wallet.toLowerCase(), history);
          if (this.useCache) this.cache.save(history);
        }
      }
    } else {
      // Fall back to sequential Data API calls
      console.log(`    Fetching ${walletsToFetch.length} wallets from Data API (no subgraph)...`);
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
      // Fetch account and redemptions in parallel
      const [account, redemptions] = await Promise.all([
        this.subgraphClient.getAccount(wallet),
        this.subgraphClient.getRedemptions(wallet),
      ]);

      if (!account) {
        // Account not found in subgraph - might be very new or never traded
        return null;
      }

      const totalTrades = account.numTrades;
      const volume = parseFloat(account.collateralVolume) / 1e6;
      const tradingProfit = parseFloat(account.profit) / 1e6; // valueSold - valueBought

      // Sum redemption payouts (resolved winning positions)
      const redemptionPayouts = redemptions.reduce(
        (sum, r) => sum + parseFloat(r.payout) / 1e6,
        0
      );

      // True profit = trading P&L + redemption payouts
      const totalProfit = tradingProfit + redemptionPayouts;

      // VALIDATION: If volume or profit exists, trades should likely be > 0.
      // If subgraph returns 0 trades but high volume, query actual trades.
      if (totalTrades === 0 && (Math.abs(volume) > 0 || Math.abs(tradingProfit) > 0.1)) {
        // Query actual trade counts for this broken account
        const tradeCounts = await this.subgraphClient.getTradeCountBatch([wallet]);
        const tradeData = tradeCounts.get(wallet.toLowerCase());
        const actualCount = tradeData?.count ?? 0;

        return {
          wallet: account.id,
          totalTrades: actualCount,
          firstTradeDate: tradeData?.firstTimestamp
            ? new Date(tradeData.firstTimestamp * 1000)
            : new Date(account.creationTimestamp * 1000),
          lastTradeDate: tradeData?.lastTimestamp
            ? new Date(tradeData.lastTimestamp * 1000)
            : new Date(account.lastSeenTimestamp * 1000),
          totalVolumeUsd: volume,
          creationDate: new Date(account.creationTimestamp * 1000),
          profitUsd: totalProfit,
          tradingProfitUsd: tradingProfit,
          redemptionPayoutsUsd: redemptionPayouts,
          dataSource: 'subgraph-trades',
        };
      }

      return {
        wallet: account.id,
        totalTrades,
        firstTradeDate: new Date(account.creationTimestamp * 1000),
        lastTradeDate: new Date(account.lastSeenTimestamp * 1000),
        totalVolumeUsd: volume,
        creationDate: new Date(account.creationTimestamp * 1000),
        profitUsd: totalProfit,
        tradingProfitUsd: tradingProfit,
        redemptionPayoutsUsd: redemptionPayouts,
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
      firstTradeDate: new Date(Math.min(...timestamps) * 1000),
      lastTradeDate: new Date(Math.max(...timestamps) * 1000),
      totalVolumeUsd: volumes.reduce((sum, v) => sum + v, 0),
      dataSource: 'data-api',
    };
  }
}
