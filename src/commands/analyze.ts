import type { Config } from '../config.js';
import { PolymarketClient } from '../api/client.js';
import { TradeFetcher } from '../api/trades.js';
import { AccountFetcher } from '../api/accounts.js';
import { createSubgraphClient, type SubgraphClient } from '../api/subgraph.js';
import { TradeSizeSignal, AccountHistorySignal, ConvictionSignal, SignalAggregator } from '../signals/index.js';
import { TradeClassifier } from '../signals/classifier.js';
import type { Trade, SignalContext } from '../signals/types.js';
import type { AnalysisReport, SuspiciousTrade } from '../output/types.js';
import { getMarketResolver, saveResolvedMarketsToDb } from '../api/market-resolver.js';
import { aggregateFills } from '../api/aggregator.js';
import type { Market, SubgraphTrade, MarketToken } from '../api/types.js';
import { buildTokenToOutcome, buildTokenToOutcomeFromResolved, aggregateFillsPerWallet } from './shared.js';
import { TradeDB, type DBTrade } from '../db/index.js';
import { TradeCacheChecker, type FetchReason } from '../api/trade-cache.js';

export interface AnalyzeOptions {
  marketId: string;
  after?: Date;
  before?: Date;
  outcome?: 'YES' | 'NO';
  maxTrades?: number;
  topN?: number;
  /**
   * Filter trades by participant role.
   * - 'taker': Only taker trades (default, recommended for insider detection)
   * - 'maker': Only maker trades
   * - 'both': Include both (may double-count volume)
   */
  role?: 'taker' | 'maker' | 'both';
  /**
   * Filter to a specific wallet's trades.
   * When set, ignores min-size and topN limits, shows verbose scoring output.
   */
  wallet?: string;
}

export class AnalyzeCommand {
  private client: PolymarketClient;
  private tradeFetcher: TradeFetcher;
  private accountFetcher: AccountFetcher;
  private subgraphClient: SubgraphClient | null;
  private tradeDb: TradeDB;
  private signals: [TradeSizeSignal, AccountHistorySignal, ConvictionSignal];
  private aggregator: SignalAggregator;
  private classifier: TradeClassifier;

  constructor(private config: Config) {
    this.client = new PolymarketClient();

    // Create subgraph client if enabled and API key is available
    this.subgraphClient = null;
    if (config.subgraph.enabled) {
      this.subgraphClient = createSubgraphClient({
        timeout: config.subgraph.timeout,
        retries: config.subgraph.retries,
      });
      if (this.subgraphClient) {
        console.log('Using The Graph subgraph as primary data source');
      }
    }

    // Initialize database for account caching
    this.tradeDb = new TradeDB();

    this.tradeFetcher = new TradeFetcher({
      subgraphClient: this.subgraphClient,
    });
    this.accountFetcher = new AccountFetcher({
      subgraphClient: this.subgraphClient,
      tradeDb: this.tradeDb,
    });
    this.signals = [
      new TradeSizeSignal(),
      new AccountHistorySignal(),
      new ConvictionSignal(),
    ];
    this.aggregator = new SignalAggregator(config);
    this.classifier = new TradeClassifier(config);
  }

  async execute(options: AnalyzeOptions): Promise<AnalysisReport> {
    // 1. Fetch market metadata (includes token IDs for subgraph queries)
    const market = await this.client.getMarket(options.marketId);

    // 2. Fetch trades
    let allTrades: Trade[];
    const role = options.role ?? this.config.tradeRole;

    // WALLET MODE: Query wallet's trades directly from subgraph (bypasses cache/limit issues)
    if (options.wallet && this.subgraphClient) {
      console.log(`Fetching trades for wallet ${options.wallet.slice(0, 8)}... on this market...`);
      const marketTokenIds = market.tokens.map(t => t.tokenId);
      const subgraphTrades = await this.subgraphClient.getTradesByWallet(options.wallet, {
        limit: 1000, // Get all wallet trades on this market
        orderDirection: 'desc',
        marketIds: marketTokenIds,
        after: options.after,
        before: options.before,
      });

      // Filter by role before aggregation
      const walletRole = options.role ?? 'maker';
      const walletLower = options.wallet.toLowerCase();
      let filteredFills = subgraphTrades;
      if (walletRole === 'taker') {
        filteredFills = subgraphTrades.filter(t => t.taker.toLowerCase() === walletLower);
      } else if (walletRole === 'maker') {
        filteredFills = subgraphTrades.filter(t => t.maker.toLowerCase() === walletLower);
      }
      // walletRole === 'both' keeps all fills

      console.log(`Found ${filteredFills.length} ${walletRole} fills for wallet on this market`);

      // Resolve token IDs to YES/NO outcomes for aggregation
      const resolver = getMarketResolver();
      const resolvedTokens = await resolver.resolveBatch(marketTokenIds);
      const tokenToOutcome = buildTokenToOutcomeFromResolved(resolvedTokens);

      // Save resolved markets to DB
      if (resolvedTokens.size > 0) {
        saveResolvedMarketsToDb(resolvedTokens, this.tradeDb);
      }

      // Fetch positions to determine which token wallet has position in
      const positions = await this.subgraphClient.getPositions(options.wallet);

      // Use centralized aggregateFills() to aggregate and filter complementary trades
      allTrades = aggregateFills(filteredFills, {
        wallet: options.wallet,
        tokenToOutcome,
        walletPositions: positions,
      });

      console.log(`Aggregated to ${allTrades.length} non-complementary transactions`);
    } else {
      // NORMAL MODE: Check DB cache first, then fetch from subgraph if needed
      const hasTokens = market.tokens && market.tokens.length > 0;

      if (this.subgraphClient && hasTokens) {
        const tokenToOutcome = buildTokenToOutcome(market);

        // Save market tokens to DB (metadata only, sync status preserved)
        const dbMarkets: import('../db/index.js').DBMarket[] = market.tokens.map((t, i) => ({
          tokenId: t.tokenId,
          conditionId: market.conditionId || null,
          question: market.question || null,
          outcome: t.outcome || null,
          outcomeIndex: i,
          resolvedAt: null,
        }));
        this.tradeDb.saveMarkets(dbMarkets);

        // DB-first: Check cache coverage and fetch only what's needed
        const rawFills = await this.fetchRawFillsWithCache(market, options);

        if (rawFills.length > 0) {
          // Aggregate fills per wallet to handle:
          // 1. Multiple fills in same tx -> one aggregated trade
          // 2. Maker/taker double-counting -> pick higher value role
          // 3. Complementary trades (YES+NO in same tx) -> filter smaller side
          allTrades = aggregateFillsPerWallet(rawFills, tokenToOutcome);
          console.log(`Aggregated ${rawFills.length} fills to ${allTrades.length} trades`);
        } else {
          allTrades = [];
        }
      } else {
        // Fallback to Data API or no subgraph (already converted to Trade format)
        allTrades = await this.tradeFetcher.getTradesForMarket(options.marketId, {
          market,
          after: options.after,
          before: options.before,
          maxTrades: options.maxTrades,
          role,
        });
      }
    }

    // 3. Filter trades
    let tradesToAnalyze: Trade[];
    if (options.outcome) {
      // User specified an outcome filter
      tradesToAnalyze = allTrades.filter(t => t.outcome === options.outcome);
    } else if (market.winningOutcome) {
      // Resolved market: filter to winning side
      tradesToAnalyze = allTrades.filter(t =>
        t.outcome === market.winningOutcome?.toUpperCase()
      );
    } else {
      // Unresolved market: analyze all trades
      tradesToAnalyze = allTrades;
    }

    // Filter to specific wallet if requested (for non-subgraph fallback)
    if (options.wallet && !this.subgraphClient) {
      const walletLower = options.wallet.toLowerCase();
      tradesToAnalyze = tradesToAnalyze.filter(t =>
        t.wallet.toLowerCase() === walletLower
      );
      console.log(`Filtered to ${tradesToAnalyze.length} trades for wallet ${options.wallet.slice(0, 8)}...`);
    }

    // === WALLET MODE: Fetch target account upfront ===
    let targetAccountHistory: import('../signals/types.js').AccountHistory | undefined;
    if (options.wallet) {
      console.log(`Fetching account history for ${options.wallet.slice(0, 8)}...`);
      const histories = await this.accountFetcher.getAccountHistoryBatch([options.wallet]);
      targetAccountHistory = histories.get(options.wallet.toLowerCase());
    }

    // === PHASE 1: Quick score all trades, collect candidate wallets ===
    console.log(`Phase 1: Quick scoring ${tradesToAnalyze.length} trades...`);

    interface QuickScoreResult {
      trade: Trade;
      quickScore: number;
      quickResults: import('../signals/types.js').SignalResult[];
    }

    const quickScores: QuickScoreResult[] = [];
    const candidateWallets = new Set<string>();
    let safeBetsFiltered = 0;

    for (let i = 0; i < tradesToAnalyze.length; i++) {
      const trade = tradesToAnalyze[i];

      if ((i + 1) % 500 === 0) {
        console.log(`  Quick scored ${i + 1}/${tradesToAnalyze.length}`);
      }

      // Filter out safe bets (high price buys/sells on resolved markets)
      // Skip in wallet mode - show all trades for the wallet
      if (
        !options.wallet &&
        this.config.filters.excludeSafeBets &&
        trade.avgPrice >= this.config.filters.safeBetThreshold &&
        (trade.side === 'BUY' || trade.side === 'SELL')
      ) {
        safeBetsFiltered++;
        continue;
      }

      // Quick score (without account history)
      const quickContext: SignalContext = { config: this.config };
      const quickResults = await Promise.all(
        this.signals.map(s => s.calculate(trade, quickContext))
      );
      const quickScore = this.aggregator.aggregate(quickResults);

      quickScores.push({ trade, quickScore: quickScore.total, quickResults });

      // Collect wallets from trades that might be suspicious
      // In wallet mode, we've already fetched the account, so skip candidate collection
      if (!options.wallet) {
        // Use alertThreshold - 10 to ensure we fetch data for all potentially flagged trades
        const candidateThreshold = Math.max(40, this.config.alertThreshold - 10);
        if (quickScore.total >= candidateThreshold) {
          candidateWallets.add(trade.wallet.toLowerCase());
        }
      }
    }

    const thresholdPct = (this.config.filters.safeBetThreshold * 100).toFixed(0);
    console.log(`  Found ${candidateWallets.size} unique candidate wallets (${safeBetsFiltered} safe bets filtered at ≥${thresholdPct}%)`);

    // === PHASE 2: Batch fetch all candidate account histories ===
    // Skip in wallet mode - we already fetched the target account
    let accountHistories = new Map<string, import('../signals/types.js').AccountHistory>();
    if (!options.wallet && candidateWallets.size > 0) {
      console.log(`Phase 2: Fetching account histories for ${candidateWallets.size} wallets...`);

      accountHistories = await this.accountFetcher.getAccountHistoryBatch(
        [...candidateWallets]
      );

      const cacheHits = [...accountHistories.values()].filter(h => h.dataSource === 'cache').length;
      const subgraphHits = [...accountHistories.values()].filter(h => h.dataSource === 'subgraph').length;
      const subgraphTradesHits = [...accountHistories.values()].filter(h => h.dataSource === 'subgraph-trades').length;
      const apiHits = [...accountHistories.values()].filter(h => h.dataSource === 'data-api').length;

      console.log(`  Fetched ${accountHistories.size} accounts (${cacheHits} cached, ${subgraphHits} subgraph, ${subgraphTradesHits} fixed, ${apiHits} API)`);
    } else if (!options.wallet) {
      console.log(`Phase 2: No candidate wallets to fetch`);
    }

    // === PHASE 3: Final scoring with account data ===
    console.log(`Phase 3: Final scoring with account histories...`);

    const scoredTrades: SuspiciousTrade[] = [];

    for (let i = 0; i < quickScores.length; i++) {
      const { trade, quickScore, quickResults } = quickScores[i];

      if ((i + 1) % 500 === 0) {
        console.log(`  Final scored ${i + 1}/${quickScores.length}`);
      }

      // Get account history - in wallet mode use pre-fetched, otherwise lookup from batch
      const accountHistory = options.wallet
        ? targetAccountHistory
        : accountHistories.get(trade.wallet.toLowerCase());

      // Final score with all context
      const fullContext: SignalContext = {
        config: this.config,
        accountHistory,
      };
      const fullResults = await Promise.all(
        this.signals.map(s => s.calculate(trade, fullContext))
      );
      const finalScore = this.aggregator.aggregate(fullResults);

      // In wallet mode: collect ALL trades for verbose output
      // In normal mode: only collect alerts
      if (options.wallet || finalScore.isAlert) {
        const suspiciousTrade: SuspiciousTrade = {
          trade,
          score: finalScore,
          accountHistory,
          // Calculate impact for classification context
          priceImpact: (fullResults[0].details as any)?.impactPercent ? {
            before: 0, // Not used by classifier currently
            after: 0,
            changePercent: (fullResults[0].details as any).impactPercent
          } : undefined
        };

        const classifications = this.classifier.classify(suspiciousTrade, finalScore, market.createdAt ? new Date(market.createdAt) : undefined);
        suspiciousTrade.classifications = classifications;

        scoredTrades.push(suspiciousTrade);
      }
    }

    console.log(`Scoring complete. Found ${scoredTrades.length} suspicious trades.`);

    // 5. Sort by score descending
    scoredTrades.sort((a, b) => b.score.total - a.score.total);

    const report: AnalysisReport = {
      market,
      totalTrades: allTrades.length,
      analyzedTrades: tradesToAnalyze.length,
      suspiciousTrades: options.wallet
        ? scoredTrades  // Return all trades in wallet mode
        : scoredTrades.slice(0, options.topN ?? 50),
      analyzedAt: new Date(),
      // Add wallet-specific fields for output formatting
      targetWallet: options.wallet,
      targetAccountHistory: options.wallet ? targetAccountHistory : undefined,
    };

    // Opportunistic backfill after analysis
    try {
      const { runBackfill } = await import('../db/backfill.js');

      const queue = this.tradeDb.getBackfillQueue();

      if (queue.length > 0 && this.subgraphClient) {
        console.log(`\nBackfilling ${Math.min(5, queue.length)} wallets from queue...`);
        await runBackfill(this.tradeDb, this.subgraphClient, { maxWallets: 5 });
      }
    } catch (e) {
      // Don't fail analysis if backfill fails
      console.error('Backfill error:', (e as Error).message);
    }

    return report;
  }

  /**
   * Fetch raw fills with DB-first caching strategy.
   * Checks cache coverage per token, fetches only missing ranges, updates sync watermarks.
   */
  private async fetchRawFillsWithCache(
    market: Market,
    options: AnalyzeOptions
  ): Promise<SubgraphTrade[]> {
    if (!this.subgraphClient) return [];

    const cacheChecker = new TradeCacheChecker(this.tradeDb);
    const totalLimit = options.maxTrades ?? 10000;
    const perTokenLimit = Math.ceil(totalLimit / market.tokens.length);

    const allFills: SubgraphTrade[] = [];

    for (const token of market.tokens) {
      const requestedRange = {
        after: options.after ? Math.floor(options.after.getTime() / 1000) : undefined,
        before: options.before ? Math.floor(options.before.getTime() / 1000) : undefined,
      };

      const cacheResult = cacheChecker.checkCoverage(token.tokenId, requestedRange);
      const reason = cacheResult.needsFetch.reason;

      if (reason !== 'none') {
        // Fetch from subgraph (only missing range if partial)
        const fetchLabel = this.getFetchLabel(reason, cacheResult.needsFetch);
        console.log(`Fetching ${token.outcome} trades from subgraph (${fetchLabel})...`);

        const newFills = await this.fetchRawFillsForToken(token, {
          after: cacheResult.needsFetch.after !== undefined
            ? new Date(cacheResult.needsFetch.after * 1000)
            : options.after,
          before: cacheResult.needsFetch.before !== undefined
            ? new Date(cacheResult.needsFetch.before * 1000)
            : options.before,
          limit: perTokenLimit,
        });

        // Save new fills to DB
        if (newFills.length > 0) {
          const saved = this.saveTradesFromFills(newFills);
          if (saved > 0) {
            console.log(`  Saved ${saved} trade records to DB`);
          }

          // Update sync watermarks
          const timestamps = newFills.map(f => f.timestamp);
          const minTs = Math.min(...timestamps);
          const maxTs = Math.max(...timestamps);

          const currentSync = this.tradeDb.getMarketSync(token.tokenId);
          this.tradeDb.updateMarketSync(token.tokenId, {
            syncedFrom: currentSync?.syncedFrom ? Math.min(currentSync.syncedFrom, minTs) : minTs,
            syncedTo: currentSync?.syncedTo ? Math.max(currentSync.syncedTo, maxTs) : maxTs,
          });
        }
      } else {
        const cachedCount = this.tradeDb.getTradesForMarket(token.tokenId, { role: 'taker' }).length;
        console.log(`Using cached ${token.outcome} trades (${cachedCount} taker fills)`);
      }

      // Read from DB (includes both cached and newly saved)
      const dbTrades = this.tradeDb.getTradesForMarket(token.tokenId, {
        after: requestedRange.after,
        before: requestedRange.before,
        limit: perTokenLimit,
      });

      // Convert DBTrade back to SubgraphTrade format for aggregation
      const fills = this.convertDBTradesToSubgraph(dbTrades, token.tokenId);
      allFills.push(...fills);
    }

    // Sort by timestamp descending and apply total limit
    allFills.sort((a, b) => b.timestamp - a.timestamp);
    return allFills.slice(0, totalLimit);
  }

  /**
   * Get human-readable label for fetch reason
   */
  private getFetchLabel(reason: FetchReason, needsFetch: { after?: number; before?: number }): string {
    switch (reason) {
      case 'missing':
        return 'not cached';
      case 'stale':
        return 'cache stale';
      case 'partial-older':
        return `fetching older trades before ${new Date((needsFetch.before ?? 0) * 1000).toISOString().split('T')[0]}`;
      case 'partial-newer':
        return `fetching newer trades after ${new Date((needsFetch.after ?? 0) * 1000).toISOString().split('T')[0]}`;
      default:
        return reason;
    }
  }

  /**
   * Fetch raw fills from subgraph for a single token
   */
  private async fetchRawFillsForToken(
    token: MarketToken,
    options: { after?: Date; before?: Date; limit?: number }
  ): Promise<SubgraphTrade[]> {
    if (!this.subgraphClient) return [];

    return this.subgraphClient.getTradesByMarket(token.tokenId, {
      limit: options.limit ?? 10000,
      after: options.after,
      before: options.before,
      orderDirection: 'desc',
    });
  }

  /**
   * Save SubgraphTrade fills to DB (both maker and taker perspectives)
   */
  private saveTradesFromFills(fills: SubgraphTrade[]): number {
    const dbTrades: DBTrade[] = [];

    for (const fill of fills) {
      const sizeNum = parseInt(fill.size);
      const priceNum = parseInt(fill.price);
      const valueUsd = Math.round((sizeNum * priceNum) / 1e6); // size * price, both 6 decimals

      // Store maker's perspective
      dbTrades.push({
        id: `${fill.id}-maker`,
        txHash: fill.transactionHash,
        wallet: fill.maker.toLowerCase(),
        marketId: fill.marketId,
        timestamp: fill.timestamp,
        side: fill.side,
        action: fill.side === 'Buy' ? 'BUY' : 'SELL', // Maker's action matches side
        role: 'maker',
        size: sizeNum,
        price: priceNum,
        valueUsd,
      });

      // Store taker's perspective
      dbTrades.push({
        id: `${fill.id}-taker`,
        txHash: fill.transactionHash,
        wallet: fill.taker.toLowerCase(),
        marketId: fill.marketId,
        timestamp: fill.timestamp,
        side: fill.side,
        action: fill.side === 'Buy' ? 'SELL' : 'BUY', // Taker's action is opposite of side
        role: 'taker',
        size: sizeNum,
        price: priceNum,
        valueUsd,
      });
    }

    return this.tradeDb.saveTrades(dbTrades);
  }

  /**
   * Convert DBTrade records back to SubgraphTrade format for aggregation.
   * Groups by fill ID (strips -maker/-taker suffix) to reconstruct original fills.
   */
  private convertDBTradesToSubgraph(dbTrades: DBTrade[], tokenId: string): SubgraphTrade[] {
    // Group trades by original fill ID (before -maker/-taker suffix)
    const fillMap = new Map<string, { maker?: DBTrade; taker?: DBTrade }>();

    for (const trade of dbTrades) {
      // Extract original fill ID (remove -maker or -taker suffix)
      const originalId = trade.id.replace(/-maker$/, '').replace(/-taker$/, '');

      if (!fillMap.has(originalId)) {
        fillMap.set(originalId, {});
      }
      const entry = fillMap.get(originalId)!;

      if (trade.role === 'maker') {
        entry.maker = trade;
      } else {
        entry.taker = trade;
      }
    }

    // Convert to SubgraphTrade format
    const fills: SubgraphTrade[] = [];

    for (const [fillId, { maker, taker }] of fillMap) {
      // Need both maker and taker to reconstruct the fill
      if (!maker || !taker) continue;

      fills.push({
        id: fillId,
        transactionHash: maker.txHash,
        timestamp: maker.timestamp,
        maker: maker.wallet,
        taker: taker.wallet,
        marketId: tokenId,
        side: maker.side as 'Buy' | 'Sell',
        size: maker.size.toString(),
        price: maker.price.toString(),
      });
    }

    return fills;
  }
}
