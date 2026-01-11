import type { TradeDB, DBMarketSync } from '../db/index.js';

export type FetchReason = 'stale' | 'partial-older' | 'partial-newer' | 'none' | 'missing';

export interface CachedTradesResult {
  sync: DBMarketSync | null;
  needsFetch: {
    after?: number;   // Fetch trades newer than this timestamp
    before?: number;  // Fetch trades older than this timestamp
    reason: FetchReason;
  };
}

export interface TradeCacheCheckerOptions {
  staleDurationSeconds?: number;  // Default: 3600 (1 hour)
}

/**
 * Checks cache coverage for market trades and determines what needs to be fetched.
 *
 * Logic:
 * - Missing: Market not in DB or never synced -> full fetch needed
 * - Stale: syncedAt + TTL < now -> fetch after syncedTo
 * - Partial-older: Requested range extends before syncedFrom -> fetch before syncedFrom
 * - Partial-newer: Requested range extends after syncedTo (and fresh) -> fetch after syncedTo
 * - None: Fresh and covers requested range -> use cache
 */
export class TradeCacheChecker {
  private db: TradeDB;
  private staleDurationSeconds: number;

  constructor(db: TradeDB, options: TradeCacheCheckerOptions = {}) {
    this.db = db;
    this.staleDurationSeconds = options.staleDurationSeconds ?? 3600; // 1 hour default
  }

  /**
   * Check if sync data is fresh (within TTL).
   */
  isFresh(syncedAt: number | null): boolean {
    if (syncedAt === null) return false;
    const now = Math.floor(Date.now() / 1000);
    return now - syncedAt < this.staleDurationSeconds;
  }

  /**
   * Check cache coverage for a market token and determine what needs to be fetched.
   *
   * @param tokenId - The market token ID
   * @param options - Optional time range filters (unix timestamps)
   * @returns Cache status and what needs to be fetched
   */
  checkCoverage(
    tokenId: string,
    options: { after?: number; before?: number } = {}
  ): CachedTradesResult {
    const sync = this.db.getMarketSync(tokenId);

    // Case 1: Market not in DB or never synced
    if (!sync || sync.syncedAt === null) {
      return {
        sync,
        needsFetch: { reason: 'missing' },
      };
    }

    // Case 2: Data is stale (past TTL)
    if (!this.isFresh(sync.syncedAt)) {
      return {
        sync,
        needsFetch: {
          after: sync.syncedTo ?? undefined,
          reason: 'stale',
        },
      };
    }

    // Data is fresh - check if it covers the requested range
    const requestedAfter = options.after;
    const requestedBefore = options.before;

    // Case 3: Requested range extends before what we have cached
    // If user wants trades from timestamp X, but our oldest cached trade is Y > X
    if (
      requestedAfter !== undefined &&
      sync.syncedFrom !== null &&
      requestedAfter < sync.syncedFrom &&
      !sync.hasCompleteHistory
    ) {
      return {
        sync,
        needsFetch: {
          before: sync.syncedFrom,
          after: requestedAfter,
          reason: 'partial-older',
        },
      };
    }

    // Case 4: Requested range extends after what we have cached
    // This shouldn't normally happen if data is fresh, but handle edge case
    if (
      requestedBefore !== undefined &&
      sync.syncedTo !== null &&
      requestedBefore > sync.syncedTo
    ) {
      return {
        sync,
        needsFetch: {
          after: sync.syncedTo,
          before: requestedBefore,
          reason: 'partial-newer',
        },
      };
    }

    // Case 5: Fresh and covers the requested range
    return {
      sync,
      needsFetch: { reason: 'none' },
    };
  }
}
