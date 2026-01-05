import type { Config } from '../config.js';
import { PolymarketClient } from '../api/client.js';
import { TradeFetcher } from '../api/trades.js';
import { AccountFetcher } from '../api/accounts.js';
import { createSubgraphClient } from '../api/subgraph.js';
import { TradeSizeSignal, AccountHistorySignal, ConvictionSignal, SignalAggregator } from '../signals/index.js';
import { TradeClassifier } from '../signals/classifier.js';
import type { Trade, SignalContext } from '../signals/types.js';
import type { AnalysisReport, SuspiciousTrade } from '../output/types.js';

export interface AnalyzeOptions {
  marketId: string;
  after?: Date;
  before?: Date;
  outcome?: 'YES' | 'NO';
  maxTrades?: number;
}

export class AnalyzeCommand {
  private client: PolymarketClient;
  private tradeFetcher: TradeFetcher;
  private accountFetcher: AccountFetcher;
  private signals: [TradeSizeSignal, AccountHistorySignal, ConvictionSignal];
  private aggregator: SignalAggregator;
  private classifier: TradeClassifier;

  constructor(private config: Config) {
    this.client = new PolymarketClient();

    // Create subgraph client if enabled and API key is available
    let subgraphClient = null;
    if (config.subgraph.enabled) {
      subgraphClient = createSubgraphClient({
        timeout: config.subgraph.timeout,
        retries: config.subgraph.retries,
      });
      if (subgraphClient) {
        console.log('Using The Graph subgraph as primary data source');
      }
    }

    this.tradeFetcher = new TradeFetcher({ subgraphClient });
    this.accountFetcher = new AccountFetcher({ subgraphClient });
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

    // 2. Fetch all trades (uses subgraph as primary if available)
    const allTrades = await this.tradeFetcher.getTradesForMarket(options.marketId, {
      market, // Pass market for subgraph token IDs
      after: options.after,
      before: options.before,
      maxTrades: options.maxTrades,
    });

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

    // 4. Score each trade
    const scoredTrades: SuspiciousTrade[] = [];
    let processed = 0;
    let accountFetches = 0;

    console.log(`Scoring ${tradesToAnalyze.length} trades...`);

    for (const trade of tradesToAnalyze) {
      processed++;
      if (processed % 100 === 0) {
        console.log(`  Progress: ${processed}/${tradesToAnalyze.length} (${accountFetches} account lookups)`);
      }

      // Quick score first (without account history)
      const quickContext: SignalContext = { config: this.config };
      const quickResults = await Promise.all(
        this.signals.map(s => s.calculate(trade, quickContext))
      );
      const quickScore = this.aggregator.aggregate(quickResults);

      // Only fetch account history for high-scoring trades (limit API calls)
      let accountHistory;
      if (quickScore.total > 60 && accountFetches < 50) {
        accountHistory = await this.accountFetcher.getAccountHistory(trade.wallet);
        accountFetches++;
      }

      // Final score with all context
      const fullContext: SignalContext = {
        config: this.config,
        accountHistory,
      };
      const fullResults = await Promise.all(
        this.signals.map(s => s.calculate(trade, fullContext))
      );
      const finalScore = this.aggregator.aggregate(fullResults);

      if (finalScore.isAlert) {
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
      suspiciousTrades: scoredTrades.slice(0, 10), // Top 10
      analyzedAt: new Date(),
    };
  }
}
