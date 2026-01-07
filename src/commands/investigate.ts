import type { Config } from '../config.js';
import { AccountFetcher } from '../api/accounts.js';
import { PolymarketClient } from '../api/client.js';
import { createSubgraphClient, type SubgraphClient } from '../api/subgraph.js';
import { getMarketResolver, type ResolvedToken } from '../api/market-resolver.js';
import { TradeSizeSignal, AccountHistorySignal, ConvictionSignal, SignalAggregator } from '../signals/index.js';
import type { AccountHistory, SignalContext } from '../signals/types.js';
import type { SubgraphTrade, SubgraphPosition, SubgraphRedemption } from '../api/types.js';
import type { SuspiciousTrade } from '../output/types.js';
import { aggregateFills } from '../api/aggregator.js';

export interface InvestigateOptions {
  wallet: string;
  tradeLimit?: number;
  resolveMarkets?: boolean;
  analyzeLimit?: number; // Number of trades to run through suspicious trade analysis (default: 100)
  market?: string; // Filter to a specific market (condition ID)
}

export interface MarketSummary {
  marketName: string;
  tradeCount: number;
  volumeUsd: number;
  positionValueUsd: number;
  positionCount: number;
  redeemedUsd: number;
  isRedeemed: boolean;
}

export interface WalletReport {
  wallet: string;
  accountHistory: AccountHistory | null;
  positions: SubgraphPosition[];
  redemptions: SubgraphRedemption[];
  recentTrades: SubgraphTrade[];
  suspicionFactors: string[];
  dataSource: 'subgraph' | 'data-api' | 'subgraph-trades' | 'subgraph-estimated' | 'cache';
  resolvedMarkets?: Map<string, ResolvedToken>;
  suspiciousTrades?: SuspiciousTrade[]; // Trades that scored above alert threshold
  analyzedTradeCount?: number; // How many trades were analyzed
  marketSummary?: MarketSummary; // Summary when filtering by specific market
}

export class InvestigateCommand {
  private accountFetcher: AccountFetcher;
  private polymarketClient: PolymarketClient;
  private subgraphClient: SubgraphClient | null;
  private signals: [TradeSizeSignal, AccountHistorySignal, ConvictionSignal];
  private aggregator: SignalAggregator;

  constructor(private config: Config) {
    this.polymarketClient = new PolymarketClient();
    // Create subgraph client if enabled and API key is available
    if (config.subgraph.enabled) {
      this.subgraphClient = createSubgraphClient({
        timeout: config.subgraph.timeout,
        retries: config.subgraph.retries,
      });
    } else {
      this.subgraphClient = null;
    }

    this.accountFetcher = new AccountFetcher({
      subgraphClient: this.subgraphClient,
    });

    // Initialize signals for trade analysis
    this.signals = [
      new TradeSizeSignal(),
      new AccountHistorySignal(),
      new ConvictionSignal(),
    ];
    this.aggregator = new SignalAggregator(config);

    if (this.subgraphClient) {
      console.log('Using The Graph subgraph for wallet investigation');
    } else if (!config.subgraph.enabled) {
      console.log('Subgraph disabled - using Data API only');
    } else {
      console.log('Warning: No subgraph API key - limited data available');
    }
  }

  async execute(options: InvestigateOptions): Promise<WalletReport> {
    const { wallet, tradeLimit = 500, resolveMarkets = true, analyzeLimit = 100, market } = options;
    const normalizedWallet = wallet.toLowerCase();

    // If market filter specified, get its token IDs and condition ID
    let marketTokenIds: Set<string> | null = null;
    let marketConditionId: string | null = null;
    let marketName: string | null = null;
    if (market) {
      try {
        const marketData = await this.polymarketClient.getMarket(market);
        marketTokenIds = new Set(marketData.tokens.map(t => t.tokenId.toLowerCase()));
        marketConditionId = marketData.conditionId?.toLowerCase() || market.toLowerCase();
        marketName = marketData.question || market;
        console.log(`Filtering to market: ${marketName}`);
      } catch (error) {
        console.log(`Warning: Could not fetch market ${market}: ${error}`);
        // Use the provided market ID as condition ID fallback
        marketConditionId = market.toLowerCase();
        marketName = market;
      }
    }

    // Fetch account history
    const accountHistory = await this.accountFetcher.getAccountHistory(normalizedWallet);

    // Fetch positions, trades, and redemptions from subgraph if available
    let positions: SubgraphPosition[] = [];
    let recentTrades: SubgraphTrade[] = [];
    let redemptions: SubgraphRedemption[] = [];

    if (this.subgraphClient) {
      try {
        // Pass market filter to subgraph query if specified (more efficient than post-fetch filtering)
        const marketIdsArray = marketTokenIds ? [...marketTokenIds] : undefined;

        [positions, recentTrades, redemptions] = await Promise.all([
          this.subgraphClient.getPositions(normalizedWallet),
          this.subgraphClient.getTradesByWallet(normalizedWallet, {
            limit: tradeLimit,
            orderDirection: 'desc',
            marketIds: marketIdsArray,
          }),
          this.subgraphClient.getRedemptions(normalizedWallet),
        ]);

        // Filter positions and redemptions by market (APIs don't support market filter yet)
        if (marketTokenIds || marketConditionId) {
          const beforePositionCount = positions.length;
          const beforeRedemptionCount = redemptions.length;

          if (marketTokenIds) {
            positions = positions.filter(p => marketTokenIds!.has(p.marketId.toLowerCase()));
          }
          if (marketConditionId) {
            redemptions = redemptions.filter(r => r.conditionId.toLowerCase() === marketConditionId);
          }

          console.log(`  Trades fetched: ${recentTrades.length} (filtered at query level)`);
          console.log(`  Filtered positions: ${positions.length}/${beforePositionCount}`);
          console.log(`  Filtered redemptions: ${redemptions.length}/${beforeRedemptionCount}`);
        }
      } catch (error) {
        console.log(`Subgraph query failed: ${error}`);
      }
    }

    // Resolve market names if requested
    let resolvedMarketsMap: Map<string, ResolvedToken> | undefined;
    if (resolveMarkets && (positions.length > 0 || recentTrades.length > 0)) {
      // Collect all unique token IDs
      const tokenIds = new Set<string>();
      for (const pos of positions) {
        if (pos.marketId) tokenIds.add(pos.marketId);
      }
      for (const trade of recentTrades) {
        if (trade.marketId) tokenIds.add(trade.marketId);
      }

      if (tokenIds.size > 0) {
        console.log(`Resolving ${tokenIds.size} market names...`);
        const resolver = getMarketResolver();
        resolvedMarketsMap = await resolver.resolveBatch([...tokenIds]);
        const resolvedCount = resolvedMarketsMap.size;
        const unresolvedCount = tokenIds.size - resolvedCount;
        if (unresolvedCount > 0) {
          console.log(`  Resolved ${resolvedCount}/${tokenIds.size} markets (${unresolvedCount} not found - may be archived)`);
        }
      }
    }

    // Analyze for suspicion factors
    const suspicionFactors = this.analyzeSuspicionFactors(accountHistory, positions);

    // Run trades through suspicious trade analyzer
    let suspiciousTrades: SuspiciousTrade[] | undefined;
    let analyzedTradeCount: number | undefined;

    if (analyzeLimit > 0 && recentTrades.length > 0 && resolvedMarketsMap) {
      const tradesToAnalyze = recentTrades.slice(0, analyzeLimit);

      // Build tokenToOutcome map from resolved markets
      const tokenToOutcome = new Map<string, 'YES' | 'NO'>();
      for (const [tokenId, resolved] of resolvedMarketsMap) {
        const outcome = resolved.outcome === 'Yes' ? 'YES' : resolved.outcome === 'No' ? 'NO' : 'YES';
        tokenToOutcome.set(tokenId.toLowerCase(), outcome);
      }

      // Aggregate fills by transaction, filtering complementary trades
      const aggregatedTrades = aggregateFills(tradesToAnalyze, {
        wallet: normalizedWallet,
        tokenToOutcome,
        walletPositions: positions,
      });

      analyzedTradeCount = aggregatedTrades.length;
      console.log(`Analyzing ${analyzedTradeCount} aggregated trades for suspicious patterns...`);

      const context: SignalContext = {
        config: this.config,
        accountHistory: accountHistory ?? undefined,
      };

      const scoredTrades: SuspiciousTrade[] = [];

      for (const trade of aggregatedTrades) {
        // Run through all signals
        const results = await Promise.all(
          this.signals.map(s => s.calculate(trade, context))
        );
        const score = this.aggregator.aggregate(results);

        if (score.isAlert) {
          scoredTrades.push({
            trade,
            score,
            accountHistory: accountHistory ?? undefined,
          });
        }
      }

      // Sort by score descending
      scoredTrades.sort((a, b) => b.score.total - a.score.total);
      suspiciousTrades = scoredTrades;

      console.log(`Found ${scoredTrades.length} suspicious trades above threshold.`);
    }

    // Calculate market-specific summary if filtering by market
    let marketSummary: MarketSummary | undefined;
    if (marketName) {
      // Calculate volume from trades (size field is already in USD with 6 decimals)
      const volumeUsd = recentTrades.reduce((sum, t) => sum + parseFloat(t.size) / 1e6, 0);

      // Calculate position value from filtered positions
      const positionValueUsd = positions.reduce((sum, p) => {
        return sum + Math.abs(parseFloat(p.netValue)) / 1e6;
      }, 0);

      // Calculate total redeemed amount
      const redeemedUsd = redemptions.reduce((sum, r) => sum + parseFloat(r.payout) / 1e6, 0);

      marketSummary = {
        marketName,
        tradeCount: recentTrades.length,
        volumeUsd,
        positionValueUsd,
        positionCount: positions.length,
        redeemedUsd,
        isRedeemed: redemptions.length > 0,
      };
    }

    return {
      wallet: normalizedWallet,
      accountHistory,
      positions,
      redemptions,
      recentTrades,
      suspicionFactors,
      dataSource: accountHistory?.dataSource ?? 'data-api',
      resolvedMarkets: resolvedMarketsMap,
      suspiciousTrades,
      analyzedTradeCount,
      marketSummary,
    };
  }

  private analyzeSuspicionFactors(
    history: AccountHistory | null,
    positions: SubgraphPosition[]
  ): string[] {
    const factors: string[] = [];

    if (!history) {
      factors.push('No trading history found');
      return factors;
    }

    // Check account age
    if (history.creationDate || history.firstTradeDate) {
      const creationDate = history.creationDate || history.firstTradeDate!;
      const ageDays = Math.floor(
        (Date.now() - creationDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (ageDays < 7) {
        factors.push(`Very new account (${ageDays} days old)`);
      } else if (ageDays < 30) {
        factors.push(`New account (${ageDays} days old)`);
      }
    }

    // Check trade count
    if (history.totalTrades < 10) {
      factors.push(`Low trade count (${history.totalTrades} trades)`);
    }

    // Check for high profit rate on new accounts using cost basis
    if (
      history.profitUsd !== undefined &&
      history.creationDate &&
      positions.length > 0
    ) {
      const ageDays = Math.floor(
        (Date.now() - history.creationDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      // Calculate cost basis from positions (sum of valueBought)
      const costBasis = positions.reduce((sum, pos) => {
        return sum + Math.abs(parseFloat(pos.valueBought)) / 1e6;
      }, 0);

      if (costBasis > 0) {
        const roi = (history.profitUsd / costBasis) * 100;

        if (ageDays < 30 && roi > 50) {
          factors.push(
            `High ROI on new account (${roi.toFixed(1)}% return in ${ageDays} days)`
          );
        }
      }
    }

    // Check position concentration
    if (positions.length === 1) {
      factors.push('Single market concentration');
    } else if (positions.length > 0 && positions.length <= 3) {
      factors.push(`Low diversification (${positions.length} markets)`);
    }

    // Check for large positions relative to volume
    const totalPositionValue = positions.reduce((sum, p) => {
      const value = Math.abs(parseFloat(p.netValue)) / 1e6;
      return sum + value;
    }, 0);

    if (totalPositionValue > 10000 && history.totalTrades < 20) {
      factors.push(
        `Large positions ($${totalPositionValue.toLocaleString()}) with few trades (${history.totalTrades})`
      );
    }

    if (factors.length === 0) {
      factors.push('No obvious suspicion factors detected');
    }

    return factors;
  }
}
