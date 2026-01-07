import type { Config } from '../config.js';
import { PolymarketClient } from '../api/client.js';
import { TradeFetcher } from '../api/trades.js';
import { AccountFetcher } from '../api/accounts.js';
import { createSubgraphClient, type SubgraphClient } from '../api/subgraph.js';
import { TradeSizeSignal, AccountHistorySignal, ConvictionSignal, SignalAggregator } from '../signals/index.js';
import { TradeClassifier } from '../signals/classifier.js';
import type { Trade, SignalContext } from '../signals/types.js';
import type { AnalysisReport, SuspiciousTrade } from '../output/types.js';
import { getMarketResolver } from '../api/market-resolver.js';

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

    this.tradeFetcher = new TradeFetcher({
      subgraphClient: this.subgraphClient,
      disableCache: !config.subgraph.cacheAccountLookup
    });
    this.accountFetcher = new AccountFetcher({
      subgraphClient: this.subgraphClient,
      cacheAccountLookup: config.subgraph.cacheAccountLookup
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

      // Resolve token IDs to YES/NO outcomes
      const resolver = getMarketResolver();
      const resolvedTokens = await resolver.resolveBatch(marketTokenIds);

      // Convert SubgraphTrade to Trade format
      allTrades = subgraphTrades.map(st => {
        const resolved = resolvedTokens.get(st.marketId.toLowerCase());
        const outcome = resolved?.outcome === 'Yes' ? 'YES' : resolved?.outcome === 'No' ? 'NO' : 'YES';

        // Determine wallet's action (maker vs taker)
        const isMaker = st.maker.toLowerCase() === options.wallet!.toLowerCase();
        const walletSide = isMaker
          ? (st.side === 'Buy' ? 'BUY' : 'SELL')
          : (st.side === 'Buy' ? 'SELL' : 'BUY');

        const valueUsd = parseFloat(st.size) / 1e6;
        const price = parseFloat(st.price);

        return {
          id: st.id,
          marketId: st.marketId,
          wallet: options.wallet!.toLowerCase(),
          side: walletSide as 'BUY' | 'SELL',
          outcome: outcome as 'YES' | 'NO',
          size: valueUsd / price, // Approximate shares
          price,
          timestamp: new Date(st.timestamp * 1000),
          valueUsd,
          maker: st.maker,
          taker: st.taker,
          role: isMaker ? 'maker' : 'taker',
        };
      });

      // Filter by role if specified (default: both for wallet mode)
      if (role === 'taker') {
        allTrades = allTrades.filter(t => t.role === 'taker');
      } else if (role === 'maker') {
        allTrades = allTrades.filter(t => t.role === 'maker');
      }

      console.log(`Found ${allTrades.length} trades for wallet on this market`);
    } else {
      // NORMAL MODE: Fetch all market trades (uses cache)
      allTrades = await this.tradeFetcher.getTradesForMarket(options.marketId, {
        market,
        after: options.after,
        before: options.before,
        maxTrades: options.maxTrades,
        role,
      });
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
        trade.price >= this.config.filters.safeBetThreshold &&
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

    return {
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
  }
}
