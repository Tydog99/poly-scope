import type { TradeDB } from '../db/index.js';
import type { AccountHistory } from '../signals/types.js';

export interface DBAccountFetcherOptions {
  db: TradeDB;
  staleDurationMs?: number; // Default 1 hour
}

/**
 * Database-aware account fetcher that retrieves cached account history
 * and converts between DB format and AccountHistory format.
 */
export class DBAccountFetcher {
  private db: TradeDB;
  private staleDurationMs: number;

  constructor(options: DBAccountFetcherOptions) {
    this.db = options.db;
    this.staleDurationMs = options.staleDurationMs ?? 60 * 60 * 1000; // 1 hour
  }

  /**
   * Retrieves account history from the database cache.
   * Returns null if account is not found.
   */
  getFromDB(wallet: string): AccountHistory | null {
    const account = this.db.getAccount(wallet);
    if (!account) return null;

    return {
      wallet: account.wallet,
      totalTrades: account.tradeCountTotal ?? 0,
      firstTradeDate: account.syncedFrom ? new Date(account.syncedFrom * 1000) : null,
      lastTradeDate: account.syncedTo ? new Date(account.syncedTo * 1000) : null,
      totalVolumeUsd: account.collateralVolume ? account.collateralVolume / 1e6 : 0,
      creationDate: account.creationTimestamp ? new Date(account.creationTimestamp * 1000) : undefined,
      profitUsd: account.profit !== null ? account.profit / 1e6 : undefined,
      dataSource: 'cache',
    };
  }

  /**
   * Checks if the cached account data is stale (older than staleDurationMs).
   * Returns true if account doesn't exist or if syncedAt is too old.
   */
  isStale(wallet: string): boolean {
    const account = this.db.getAccount(wallet);
    if (!account || account.syncedAt === null) return true;

    const syncedAtMs = account.syncedAt * 1000;
    return Date.now() - syncedAtMs > this.staleDurationMs;
  }

  /**
   * Saves account history from subgraph to the database cache.
   * Converts AccountHistory format to DB format.
   */
  saveToDBFromSubgraph(history: AccountHistory): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.saveAccount({
      wallet: history.wallet,
      creationTimestamp: history.creationDate ? Math.floor(history.creationDate.getTime() / 1000) : null,
      syncedFrom: history.firstTradeDate ? Math.floor(history.firstTradeDate.getTime() / 1000) : null,
      syncedTo: history.lastTradeDate ? Math.floor(history.lastTradeDate.getTime() / 1000) : now,
      syncedAt: now,
      tradeCountTotal: history.totalTrades,
      collateralVolume: Math.round(history.totalVolumeUsd * 1e6),
      profit: history.profitUsd !== undefined ? Math.round(history.profitUsd * 1e6) : null,
      hasFullHistory: false,
    });
  }
}
