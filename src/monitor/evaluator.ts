import type { Trade, AccountHistory, SignalContext, SignalResult } from '../signals/types.js';
import type { RTDSTradeEvent, EvaluatedTrade } from './types.js';
import type { Config } from '../config.js';
import { TradeSizeSignal } from '../signals/tradeSize.js';
import { AccountHistorySignal } from '../signals/accountHistory.js';
import { ConvictionSignal } from '../signals/conviction.js';
import { DEFAULT_CONFIG } from '../config.js';

/**
 * Cache entry with TTL tracking
 */
interface CacheEntry {
  data: AccountHistory;
  cachedAt: number;
}

/**
 * Options for the MonitorEvaluator
 */
export interface EvaluatorOptions {
  minSize: number;
  threshold: number;
  cacheTtlMs?: number;
  config?: Config;
}

/**
 * Evaluates incoming trades using existing signals with an in-memory session cache.
 * Designed for real-time monitoring where we want to avoid repeated lookups
 * for the same wallet within a session.
 */
export class MonitorEvaluator {
  private readonly minSize: number;
  private readonly threshold: number;
  private readonly cacheTtlMs: number;
  private readonly config: Config;

  // Session cache for account history
  private readonly accountCache: Map<string, CacheEntry> = new Map();

  // Signal instances
  private readonly tradeSizeSignal: TradeSizeSignal;
  private readonly accountHistorySignal: AccountHistorySignal;
  private readonly convictionSignal: ConvictionSignal;

  constructor(options: EvaluatorOptions) {
    this.minSize = options.minSize;
    this.threshold = options.threshold;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000; // 5 minutes default
    this.config = options.config ?? DEFAULT_CONFIG;

    // Initialize signal instances
    this.tradeSizeSignal = new TradeSizeSignal();
    this.accountHistorySignal = new AccountHistorySignal();
    this.convictionSignal = new ConvictionSignal();
  }

  /**
   * Check if a trade should be evaluated based on minSize threshold.
   * Calculates trade value as size * price (shares * price per share).
   */
  shouldEvaluate(event: RTDSTradeEvent): boolean {
    const valueUsd = event.size * event.price;
    return valueUsd >= this.minSize;
  }

  /**
   * Check if account data is in cache and not expired.
   */
  isCached(wallet: string): boolean {
    const entry = this.accountCache.get(wallet.toLowerCase());
    if (!entry) return false;

    const now = Date.now();
    if (now - entry.cachedAt > this.cacheTtlMs) {
      this.accountCache.delete(wallet.toLowerCase());
      return false;
    }

    return true;
  }

  /**
   * Get cached account data, or null if not cached/expired.
   */
  getCached(wallet: string): AccountHistory | null {
    if (!this.isCached(wallet)) return null;
    return this.accountCache.get(wallet.toLowerCase())!.data;
  }

  /**
   * Store account data in session cache.
   */
  cacheAccount(wallet: string, history: AccountHistory): void {
    this.accountCache.set(wallet.toLowerCase(), {
      data: history,
      cachedAt: Date.now(),
    });
  }

  /**
   * Convert RTDSTradeEvent to the Trade type used by signals.
   */
  normalizeEvent(event: RTDSTradeEvent): Trade {
    return {
      id: event.transactionHash,
      marketId: event.asset,
      wallet: event.proxyWallet,
      side: event.side,
      outcome: event.outcome.toUpperCase() === 'YES' ? 'YES' : 'NO',
      size: event.size,
      price: event.price,
      timestamp: new Date(event.timestamp * 1000),
      valueUsd: event.size * event.price,
    };
  }

  /**
   * Evaluate a trade using all three signals.
   * Returns the evaluated trade with scores and alert status.
   */
  async evaluate(event: RTDSTradeEvent, account?: AccountHistory): Promise<EvaluatedTrade> {
    const trade = this.normalizeEvent(event);

    const context: SignalContext = {
      config: this.config,
      accountHistory: account,
      marketPrices: [], // Real-time monitoring doesn't have historical prices
    };

    // Run all signals in parallel
    const [tradeSizeResult, accountHistoryResult, convictionResult] = await Promise.all([
      this.tradeSizeSignal.calculate(trade, context),
      this.accountHistorySignal.calculate(trade, context),
      this.convictionSignal.calculate(trade, context),
    ]);

    // Calculate weighted scores
    const tradeSizeWeighted = (tradeSizeResult.score * tradeSizeResult.weight) / 100;
    const accountHistoryWeighted = (accountHistoryResult.score * accountHistoryResult.weight) / 100;
    const convictionWeighted = (convictionResult.score * convictionResult.weight) / 100;

    const totalScore = Math.round(tradeSizeWeighted + accountHistoryWeighted + convictionWeighted);
    const isAlert = totalScore >= this.threshold;

    return {
      event,
      score: totalScore,
      isAlert,
      signals: {
        tradeSize: {
          score: tradeSizeResult.score,
          weight: tradeSizeResult.weight,
          weighted: Math.round(tradeSizeWeighted),
        },
        accountHistory: {
          score: accountHistoryResult.score,
          weight: accountHistoryResult.weight,
          weighted: Math.round(accountHistoryWeighted),
        },
        conviction: {
          score: convictionResult.score,
          weight: convictionResult.weight,
          weighted: Math.round(convictionWeighted),
        },
      },
      account,
    };
  }

  /**
   * Clear all cached account data.
   */
  clearCache(): void {
    this.accountCache.clear();
  }

  /**
   * Get the number of cached accounts.
   */
  getCacheSize(): number {
    return this.accountCache.size;
  }
}
