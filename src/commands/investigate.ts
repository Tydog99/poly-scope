import type { Config } from '../config.js';
import { AccountFetcher } from '../api/accounts.js';
import { createSubgraphClient, type SubgraphClient } from '../api/subgraph.js';
import type { AccountHistory } from '../signals/types.js';
import type { SubgraphTrade, SubgraphPosition } from '../api/types.js';

export interface InvestigateOptions {
  wallet: string;
  tradeLimit?: number;
}

export interface WalletReport {
  wallet: string;
  accountHistory: AccountHistory | null;
  positions: SubgraphPosition[];
  recentTrades: SubgraphTrade[];
  suspicionFactors: string[];
  dataSource: 'subgraph' | 'data-api';
}

export class InvestigateCommand {
  private accountFetcher: AccountFetcher;
  private subgraphClient: SubgraphClient | null;

  constructor(private config: Config) {
    this.subgraphClient = createSubgraphClient();
    this.accountFetcher = new AccountFetcher({
      subgraphClient: this.subgraphClient,
    });

    if (this.subgraphClient) {
      console.log('Using The Graph subgraph for wallet investigation');
    } else {
      console.log('Warning: No subgraph API key - limited data available');
    }
  }

  async execute(options: InvestigateOptions): Promise<WalletReport> {
    const { wallet, tradeLimit = 20 } = options;
    const normalizedWallet = wallet.toLowerCase();

    // Fetch account history
    const accountHistory = await this.accountFetcher.getAccountHistory(normalizedWallet);

    // Fetch positions and trades from subgraph if available
    let positions: SubgraphPosition[] = [];
    let recentTrades: SubgraphTrade[] = [];

    if (this.subgraphClient) {
      try {
        [positions, recentTrades] = await Promise.all([
          this.subgraphClient.getPositions(normalizedWallet),
          this.subgraphClient.getTradesByWallet(normalizedWallet, {
            limit: tradeLimit,
            orderDirection: 'desc',
          }),
        ]);
      } catch (error) {
        console.log(`Subgraph query failed: ${error}`);
      }
    }

    // Analyze for suspicion factors
    const suspicionFactors = this.analyzeSuspicionFactors(accountHistory, positions);

    return {
      wallet: normalizedWallet,
      accountHistory,
      positions,
      recentTrades,
      suspicionFactors,
      dataSource: accountHistory?.dataSource ?? 'data-api',
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

    // Check for high profit rate on new accounts
    if (
      history.profitUsd !== undefined &&
      history.totalVolumeUsd > 0 &&
      history.creationDate
    ) {
      const ageDays = Math.floor(
        (Date.now() - history.creationDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      const profitRate = history.profitUsd / history.totalVolumeUsd;

      if (ageDays < 30 && profitRate > 0.3) {
        factors.push(
          `High profit rate on new account (${(profitRate * 100).toFixed(1)}% return in ${ageDays} days)`
        );
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
