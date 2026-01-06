import type { Config } from '../config.js';
import { AccountFetcher } from '../api/accounts.js';
import { createSubgraphClient, type SubgraphClient } from '../api/subgraph.js';
import { getMarketResolver, type ResolvedToken } from '../api/market-resolver.js';
import type { AccountHistory } from '../signals/types.js';
import type { SubgraphTrade, SubgraphPosition, SubgraphRedemption } from '../api/types.js';

export interface InvestigateOptions {
  wallet: string;
  tradeLimit?: number;
  resolveMarkets?: boolean;
}

export interface WalletReport {
  wallet: string;
  accountHistory: AccountHistory | null;
  positions: SubgraphPosition[];
  redemptions: SubgraphRedemption[];
  recentTrades: SubgraphTrade[];
  suspicionFactors: string[];
  dataSource: 'subgraph' | 'data-api' | 'subgraph-trades' | 'cache';
  resolvedMarkets?: Map<string, ResolvedToken>;
}

export class InvestigateCommand {
  private accountFetcher: AccountFetcher;
  private subgraphClient: SubgraphClient | null;

  constructor(private config: Config) {
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

    if (this.subgraphClient) {
      console.log('Using The Graph subgraph for wallet investigation');
    } else if (!config.subgraph.enabled) {
      console.log('Subgraph disabled - using Data API only');
    } else {
      console.log('Warning: No subgraph API key - limited data available');
    }
  }

  async execute(options: InvestigateOptions): Promise<WalletReport> {
    const { wallet, tradeLimit = 500, resolveMarkets = true } = options;
    const normalizedWallet = wallet.toLowerCase();

    // Fetch account history
    const accountHistory = await this.accountFetcher.getAccountHistory(normalizedWallet);

    // Fetch positions, trades, and redemptions from subgraph if available
    let positions: SubgraphPosition[] = [];
    let recentTrades: SubgraphTrade[] = [];
    let redemptions: SubgraphRedemption[] = [];

    if (this.subgraphClient) {
      try {
        [positions, recentTrades, redemptions] = await Promise.all([
          this.subgraphClient.getPositions(normalizedWallet),
          this.subgraphClient.getTradesByWallet(normalizedWallet, {
            limit: tradeLimit,
            orderDirection: 'desc',
          }),
          this.subgraphClient.getRedemptions(normalizedWallet),
        ]);
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

    return {
      wallet: normalizedWallet,
      accountHistory,
      positions,
      redemptions,
      recentTrades,
      suspicionFactors,
      dataSource: accountHistory?.dataSource ?? 'data-api',
      resolvedMarkets: resolvedMarketsMap,
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
