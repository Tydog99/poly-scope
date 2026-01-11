import type { AccountHistory } from '../signals/types.js';
import type { SubgraphClient } from './subgraph.js';
import type { SubgraphRedemption, TradeCountData } from './types.js';
import { TradeDB } from '../db/index.js';

const DATA_API = 'https://data-api.polymarket.com';

interface DataApiTrade {
  proxyWallet: string;
  size: string;
  price: string;
  timestamp: number;
}

export interface AccountFetcherOptions {
  subgraphClient?: SubgraphClient | null;
  tradeDb?: TradeDB;
}

export class AccountFetcher {
  private subgraphClient: SubgraphClient | null;
  private tradeDb: TradeDB | null;

  constructor(options: AccountFetcherOptions = {}) {
    this.subgraphClient = options.subgraphClient || null;
    this.tradeDb = options.tradeDb || null;
  }

  /**
   * Check if history is already in cache (TradeDB)
   */
  isCached(wallet: string): boolean {
    if (!this.tradeDb) return false;
    const account = this.tradeDb.getAccount(wallet);
    if (!account || !account.syncedAt) return false;
    const staleMs = 60 * 60 * 1000; // 1 hour
    return Date.now() - account.syncedAt * 1000 < staleMs;
  }

  /**
   * Get account history, preferring subgraph data when available
   */
  async getAccountHistory(
    wallet: string,
    options: { skipNetwork?: boolean } = {}
  ): Promise<AccountHistory | null> {
    // Check SQLite DB first (if available)
    if (this.tradeDb) {
      const account = this.tradeDb.getAccount(wallet);
      if (account && account.syncedAt) {
        const staleMs = 60 * 60 * 1000; // 1 hour
        const isFresh = Date.now() - account.syncedAt * 1000 < staleMs;
        if (isFresh) {
          return {
            wallet: account.wallet,
            totalTrades: account.tradeCountTotal ?? 0,
            firstTradeDate: account.syncedFrom ? new Date(account.syncedFrom * 1000) : null,
            lastTradeDate: account.syncedTo ? new Date(account.syncedTo * 1000) : null,
            totalVolumeUsd: account.collateralVolume ? account.collateralVolume / 1e6 : 0,
            creationDate: account.creationTimestamp ? new Date(account.creationTimestamp * 1000) : undefined,
            profitUsd: account.profit ? account.profit / 1e6 : undefined,
            dataSource: 'cache',
          };
        }
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

    // Save to TradeDB for future cache hits
    if (this.tradeDb && history) {
      const now = Math.floor(Date.now() / 1000);
      this.tradeDb.saveAccount({
        wallet: history.wallet,
        creationTimestamp: history.creationDate ? Math.floor(history.creationDate.getTime() / 1000) : null,
        syncedFrom: history.firstTradeDate ? Math.floor(history.firstTradeDate.getTime() / 1000) : null,
        syncedTo: history.lastTradeDate ? Math.floor(history.lastTradeDate.getTime() / 1000) : now,
        syncedAt: now,
        tradeCountTotal: history.totalTrades,
        collateralVolume: Math.round(history.totalVolumeUsd * 1e6),
        profit: history.profitUsd ? Math.round(history.profitUsd * 1e6) : null,
        hasFullHistory: false,
      });
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
    const staleMs = 60 * 60 * 1000; // 1 hour

    // Check DB cache first for all wallets
    for (const wallet of wallets) {
      const normalizedWallet = wallet.toLowerCase();

      if (this.tradeDb) {
        const account = this.tradeDb.getAccount(normalizedWallet);
        if (account && account.syncedAt) {
          const isFresh = Date.now() - account.syncedAt * 1000 < staleMs;
          if (isFresh) {
            // Return cached data
            results.set(normalizedWallet, {
              wallet: account.wallet,
              totalTrades: account.tradeCountTotal ?? 0,
              firstTradeDate: account.syncedFrom ? new Date(account.syncedFrom * 1000) : null,
              lastTradeDate: account.syncedTo ? new Date(account.syncedTo * 1000) : null,
              totalVolumeUsd: account.collateralVolume ? account.collateralVolume / 1e6 : 0,
              creationDate: account.creationTimestamp ? new Date(account.creationTimestamp * 1000) : undefined,
              profitUsd: account.profit ? account.profit / 1e6 : undefined,
              dataSource: 'cache',
            });
            continue;
          }
        }
      }
      walletsToFetch.push(wallet);
    }

    if (walletsToFetch.length === 0) {
      return results;
    }

    const cacheHits = wallets.length - walletsToFetch.length;
    if (cacheHits > 0) {
      console.log(`    ${cacheHits} accounts from cache, ${walletsToFetch.length} to fetch`);
    }

    // Fetch wallets
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
      console.log(`    Fetching redemptions for ${walletsToFetch.length} wallets...`);
      const allRedemptions = await this.subgraphClient.getRedemptionsBatch(walletsToFetch);

      // Save redemptions to DB
      if (this.tradeDb) {
        const dbRedemptions: import('../db/index.js').DBRedemption[] = [];
        for (const [wallet, redemptions] of allRedemptions) {
          for (const r of redemptions) {
            dbRedemptions.push({
              id: r.id,
              wallet: wallet.toLowerCase(),
              conditionId: r.conditionId,
              timestamp: r.timestamp,
              payout: parseInt(r.payout), // Already 6 decimals from subgraph
            });
          }
        }
        if (dbRedemptions.length > 0) {
          this.tradeDb.saveRedemptions(dbRedemptions);
        }
      }

      console.log(`    Fetching account data...`);

      // Process chunks sequentially to avoid rate limiting
      const batchTimes: number[] = [];
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];
        const batchStart = Date.now();

        if (chunks.length > 1) {
          const avgTime = batchTimes.length > 0
            ? batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length
            : 0;
          const remaining = chunks.length - chunkIdx;
          const etaStr = avgTime > 0
            ? `, ~${Math.ceil((avgTime * remaining) / 1000)}s remaining`
            : '';
          const lastTimeStr = batchTimes.length > 0
            ? ` (last: ${(batchTimes[batchTimes.length - 1] / 1000).toFixed(1)}s${etaStr})`
            : '';
          console.log(`    Batch ${chunkIdx + 1}/${chunks.length} (${chunk.length} wallets)${lastTimeStr}`);
        }

        const accounts = await this.subgraphClient.getAccountBatch(chunk);
        batchTimes.push(Date.now() - batchStart);
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
            // HIGH VOLUME OPTIMIZATION: Skip trade count query for high-volume accounts
            // If volume > $100k, they're clearly established traders - estimate high trade count
            // Math: $100k / $2k avg trade = 50 trades minimum (our "established" threshold)
            // This prevents timeouts from querying accounts with many trades
            const HIGH_VOLUME_THRESHOLD = 100_000; // $100k
            const ESTIMATED_WHALE_TRADES = 1000; // Conservative estimate for scoring purposes

            if (volume > HIGH_VOLUME_THRESHOLD) {
              if (process.env.DEBUG) {
                console.log(`    Skipping trade count for whale ${account.id.slice(0, 10)}... ($${Math.round(volume).toLocaleString()} volume)`);
              }
              const history: AccountHistory = {
                wallet: account.id,
                totalTrades: ESTIMATED_WHALE_TRADES,
                firstTradeDate: new Date(account.creationTimestamp * 1000),
                lastTradeDate: new Date(account.lastSeenTimestamp * 1000),
                totalVolumeUsd: volume,
                creationDate: new Date(account.creationTimestamp * 1000),
                profitUsd: totalProfit,
                tradingProfitUsd: tradingProfit,
                redemptionPayoutsUsd: redemptionPayouts,
                dataSource: 'subgraph-estimated',
              };
              results.set(wallet.toLowerCase(), history);
              continue;
            }

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
        }
      }

      // Query actual trade counts for broken accounts
      if (brokenAccounts.length > 0) {
        const brokenWallets = brokenAccounts.map((a) => a.wallet);
        console.log(`    Querying actual trade counts for ${brokenAccounts.length} broken Account entities...`);

        try {
          const tradeCounts = await this.subgraphClient.getTradeCountBatch(brokenWallets);

          // Process all broken accounts with trade counts
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
          }
        } catch (error) {
          const err = error as Error;
          console.log(`\n        ERROR: Trade count query failed after retries`);
          console.log(`        Remaining: ${brokenWallets.length} wallets`);
          console.log(`        Error: ${err.message.slice(0, 200)}${err.message.length > 200 ? '...' : ''}`);
          console.log(`        Tip: Use --no-subgraph for Data API fallback\n`);
          throw new Error(
            `Subgraph indexers unavailable. ${brokenWallets.length} wallets remaining.`
          );
        }
      }

      // For wallets not found in subgraph, try Data API
      const missing = walletsToFetch.filter((w) => !results.has(w.toLowerCase()));
      if (missing.length > 0) {
        console.log(`    Fetching ${missing.length} missing wallets from Data API...`);
        for (const wallet of missing) {
          const history = await this.getFromDataApi(wallet);
          results.set(wallet.toLowerCase(), history);
        }
      }
    } else {
      // Fall back to sequential Data API calls
      console.log(`    Fetching ${walletsToFetch.length} wallets from Data API (no subgraph)...`);
      for (const wallet of walletsToFetch) {
        const history = await this.getFromDataApi(wallet);
        results.set(wallet.toLowerCase(), history);
      }
    }

    // Save all freshly-fetched accounts to DB for future cache hits
    if (this.tradeDb) {
      const now = Math.floor(Date.now() / 1000);
      for (const [wallet, history] of results) {
        // Skip accounts that were from cache (already in DB)
        if (history.dataSource === 'cache') continue;

        this.tradeDb.saveAccount({
          wallet: history.wallet,
          creationTimestamp: history.creationDate ? Math.floor(history.creationDate.getTime() / 1000) : null,
          syncedFrom: history.firstTradeDate ? Math.floor(history.firstTradeDate.getTime() / 1000) : null,
          syncedTo: history.lastTradeDate ? Math.floor(history.lastTradeDate.getTime() / 1000) : now,
          syncedAt: now,
          tradeCountTotal: history.totalTrades,
          collateralVolume: Math.round(history.totalVolumeUsd * 1e6),
          profit: history.profitUsd ? Math.round(history.profitUsd * 1e6) : null,
          hasFullHistory: false,
        });
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
