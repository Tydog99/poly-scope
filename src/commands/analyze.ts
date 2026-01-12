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
import type { Market, SubgraphTrade, MarketToken, AggregatedTrade } from '../api/types.js';
import { buildTokenToOutcome, buildTokenToOutcomeFromResolved, aggregateFillsPerWallet } from './shared.js';
import { TradeDB, type DBEnrichedOrderFill } from '../db/index.js';
import { TradeCacheChecker, type FetchReason } from '../api/trade-cache.js';
import { PriceFetcher } from '../api/prices.js';

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
  private priceFetcher: PriceFetcher;
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
    this.priceFetcher = new PriceFetcher(this.tradeDb);

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

  private getTradeTimeRange(trades: Trade[]): { startTs: number; endTs: number } {
    if (trades.length === 0) {
      const now = Math.floor(Date.now() / 1000);
      return { startTs: now - 300, endTs: now };
    }

    const timestamps = trades.map(t => Math.floor(t.timestamp.getTime() / 1000));
    const buffer = 5 * 60;  // 5 minute buffer
    return {
      startTs: Math.min(...timestamps) - buffer,
      endTs: Math.max(...timestamps) + buffer,
    };
  }

  async execute(options: AnalyzeOptions): Promise<AnalysisReport> {
    // 1. Fetch market metadata (includes token IDs for subgraph queries)
    const market = await this.client.getMarket(options.marketId);

    // 2. Fetch trades
    let allTrades: Trade[];

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
          const uniqueWallets = new Set(allTrades.map(t => t.wallet)).size;
          console.log(`Processed ${rawFills.length} fills → ${allTrades.length} trades across ${uniqueWallets} wallets`);
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

    // Fetch price history for market impact calculation
    let marketPrices: Map<string, import('../signals/types.js').PricePoint[]> | undefined;
    if (allTrades.length > 0 && market.tokens?.length > 0) {
      const tokenIds = market.tokens.map(t => t.tokenId);
      const { startTs, endTs } = this.getTradeTimeRange(allTrades);

      console.log(`Fetching price history for ${tokenIds.length} tokens...`);
      const priceData = await this.priceFetcher.getPricesForMarket(tokenIds, startTs, endTs);

      // Convert to PricePoint format (Date timestamp)
      marketPrices = new Map();
      for (const [tokenId, prices] of priceData) {
        marketPrices.set(tokenId, prices.map(p => ({
          timestamp: new Date(p.timestamp * 1000),
          price: p.price,
        })));
      }

      const totalPrices = [...priceData.values()].reduce((sum, p) => sum + p.length, 0);
      console.log(`  Loaded ${totalPrices} price points`);
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
      const quickContext: SignalContext = { config: this.config, marketPrices };
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

    // === PRE-COMPUTE: Build aggregated trade cache for candidate wallets ===
    // This avoids O(n) expensive getAccountStateAt calls per trade
    const walletTradeCache = new Map<string, AggregatedTrade[]>();
    const walletsToCache = options.wallet && targetAccountHistory
      ? [options.wallet.toLowerCase()]
      : [...candidateWallets];

    if (walletsToCache.length > 0) {
      console.log(`  Pre-computing trade histories for ${walletsToCache.length} candidates...`);
      for (const wallet of walletsToCache) {
        const fills = this.tradeDb.getFillsForWallet(wallet, { role: 'both' });
        if (fills.length === 0) continue;

        // Get market metadata
        const tokenIds = [...new Set(fills.map(f => f.market))];
        const markets = this.tradeDb.getMarketsForTokenIds(tokenIds);

        // Build tokenToOutcome map using outcomeIndex (0 = YES, 1 = NO)
        // This is more reliable than string matching for non-binary markets (e.g., "Up"/"Down")
        const tokenToOutcome = new Map<string, 'YES' | 'NO'>();
        for (const tokenId of tokenIds) {
          const market = markets.get(tokenId);
          tokenToOutcome.set(tokenId.toLowerCase(),
            market?.outcomeIndex === 0 ? 'YES' : 'NO');
        }

        // Convert to SubgraphTrade format
        const subgraphFills: SubgraphTrade[] = fills.map(f => ({
          id: f.id,
          transactionHash: f.transactionHash,
          timestamp: f.timestamp,
          maker: f.maker,
          taker: f.taker,
          marketId: f.market,
          side: f.side,
          size: f.size.toString(),
          price: (f.price / 1e6).toString(),
        }));

        // Aggregate once for this wallet
        const aggregated = aggregateFills(subgraphFills, { wallet, tokenToOutcome });
        walletTradeCache.set(wallet, aggregated);
      }
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

      // Get point-in-time volume from pre-computed cache (fast O(n) filter instead of O(n) DB queries)
      let historicalState: SignalContext['historicalState'];
      if (accountHistory) {
        const cachedTrades = walletTradeCache.get(trade.wallet.toLowerCase());
        if (cachedTrades) {
          const tradeTimestamp = trade.timestamp.getTime() / 1000;
          const priorTrades = cachedTrades.filter(t => t.timestamp.getTime() / 1000 < tradeTimestamp);
          const priorVolume = priorTrades.reduce((sum, t) => sum + t.totalValueUsd, 0);

          // Find most recent prior trade for dormancy calculation
          const lastPriorTrade = priorTrades.length > 0
            ? priorTrades.reduce((latest, t) =>
              t.timestamp.getTime() > latest.timestamp.getTime() ? t : latest)
            : null;

          historicalState = {
            tradeCount: priorTrades.length,
            volume: Math.round(priorVolume * 1e6),
            pnl: 0, // TODO: Calculate point-in-time PnL from priorTrades
            lastTradeTimestamp: lastPriorTrade
              ? Math.floor(lastPriorTrade.timestamp.getTime() / 1000)
              : undefined,
            approximate: false,
          };
        }
      }

      // Final score with all context
      const fullContext: SignalContext = {
        config: this.config,
        accountHistory,
        historicalState,
        marketPrices,
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
        const cachedCount = this.tradeDb.getFillsForMarket(token.tokenId).length;
        console.log(`Using cached ${token.outcome} trades (${cachedCount} fills)`);
      }

      // Read from DB (includes both cached and newly saved)
      // Note: Don't limit per-token here - let the final sort+limit handle it
      // This ensures we get all fills including older maker fills needed for
      // proper complementary trade detection in cross-matched transactions
      const dbFills = this.tradeDb.getFillsForMarket(token.tokenId, {
        after: requestedRange.after,
        before: requestedRange.before,
        // No per-token limit - apply total limit after combining both tokens
      });

      // Convert DBEnrichedOrderFill back to SubgraphTrade format for aggregation
      const fills = this.convertDBFillsToSubgraph(dbFills);
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
   * Save SubgraphTrade fills to DB (one row per fill)
   */
  private saveTradesFromFills(fills: SubgraphTrade[]): number {
    const dbFills: DBEnrichedOrderFill[] = fills.map(fill => ({
      id: fill.id,
      transactionHash: fill.transactionHash,
      timestamp: fill.timestamp,
      orderHash: (fill as any).orderHash ?? fill.id, // Use id as fallback if orderHash missing
      side: fill.side,
      size: parseInt(fill.size),
      price: Math.round(parseFloat(fill.price) * 1e6),
      maker: fill.maker.toLowerCase(),
      taker: fill.taker.toLowerCase(),
      market: fill.marketId,
    }));

    return this.tradeDb.saveFills(dbFills);
  }

  /**
   * Convert DBEnrichedOrderFill records back to SubgraphTrade format for aggregation
   */
  private convertDBFillsToSubgraph(dbFills: DBEnrichedOrderFill[]): SubgraphTrade[] {
    return dbFills.map(f => ({
      id: f.id,
      transactionHash: f.transactionHash,
      timestamp: f.timestamp,
      orderHash: f.orderHash,
      maker: f.maker,
      taker: f.taker,
      marketId: f.market,
      side: f.side,
      size: f.size.toString(),
      price: (f.price / 1e6).toString(), // Convert back to decimal string
    }));
  }
}
