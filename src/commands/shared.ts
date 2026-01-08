import type { Market, SubgraphTrade } from '../api/types.js';
import type { ResolvedToken } from '../api/market-resolver.js';
import type { Trade, SignalContext, SignalResult } from '../signals/types.js';
import type { SuspiciousTrade } from '../output/types.js';
import { aggregateFills } from '../api/aggregator.js';
import type { Signal } from '../signals/types.js';
import type { SignalAggregator } from '../signals/aggregator.js';

/**
 * Build a tokenId -> outcome mapping from market tokens
 */
export function buildTokenToOutcome(market: Market): Map<string, 'YES' | 'NO'> {
  const tokenToOutcome = new Map<string, 'YES' | 'NO'>();
  for (const token of market.tokens) {
    tokenToOutcome.set(
      token.tokenId.toLowerCase(),
      token.outcome.toUpperCase() as 'YES' | 'NO'
    );
  }
  return tokenToOutcome;
}

/**
 * Build a tokenId -> outcome mapping from resolved tokens.
 * Uses outcomeIndex (0 = YES, 1 = NO) for reliable mapping on all market types,
 * not string matching which fails on non-binary markets like "Up"/"Down".
 */
export function buildTokenToOutcomeFromResolved(
  resolvedTokens: Map<string, ResolvedToken>
): Map<string, 'YES' | 'NO'> {
  const tokenToOutcome = new Map<string, 'YES' | 'NO'>();
  for (const [tokenId, resolved] of resolvedTokens) {
    // Index 0 = first outcome (YES side), Index 1 = second outcome (NO side)
    const outcome = resolved.outcomeIndex === 0 ? 'YES' : 'NO';
    tokenToOutcome.set(tokenId.toLowerCase(), outcome);
  }
  return tokenToOutcome;
}

/**
 * Aggregate fills per wallet for multi-wallet analysis.
 * Groups fills by taker wallet, then aggregates each wallet's fills.
 */
export function aggregateFillsPerWallet(
  fills: SubgraphTrade[],
  tokenToOutcome: Map<string, 'YES' | 'NO'>
): Trade[] {
  // Group fills by wallet (using taker as the wallet - taker analysis)
  const fillsByWallet = new Map<string, SubgraphTrade[]>();
  for (const fill of fills) {
    const wallet = fill.taker?.toLowerCase();
    if (!wallet) continue;

    if (!fillsByWallet.has(wallet)) {
      fillsByWallet.set(wallet, []);
    }
    fillsByWallet.get(wallet)!.push(fill);
  }

  // Aggregate each wallet's fills
  const allTrades: Trade[] = [];
  for (const [wallet, walletFills] of fillsByWallet) {
    const aggregated = aggregateFills(walletFills, {
      wallet,
      tokenToOutcome,
    });
    allTrades.push(...aggregated);
  }

  // Sort by timestamp descending
  allTrades.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return allTrades;
}

/**
 * Score a single trade through all signals
 */
export async function scoreTrade(
  trade: Trade,
  signals: Signal[],
  aggregator: SignalAggregator,
  context: SignalContext
): Promise<SuspiciousTrade | null> {
  const results = await Promise.all(
    signals.map(s => s.calculate(trade, context))
  );
  const score = aggregator.aggregate(results);

  if (!score.isAlert) {
    return null;
  }

  return {
    trade,
    score,
    accountHistory: context.accountHistory,
  };
}

/**
 * Score multiple trades through all signals
 */
export async function scoreTrades(
  trades: Trade[],
  signals: Signal[],
  aggregator: SignalAggregator,
  context: SignalContext,
  options?: {
    onProgress?: (current: number, total: number) => void;
    progressInterval?: number;
  }
): Promise<SuspiciousTrade[]> {
  const { onProgress, progressInterval = 500 } = options ?? {};
  const results: SuspiciousTrade[] = [];

  for (let i = 0; i < trades.length; i++) {
    if (onProgress && (i + 1) % progressInterval === 0) {
      onProgress(i + 1, trades.length);
    }

    const scored = await scoreTrade(trades[i], signals, aggregator, context);
    if (scored) {
      results.push(scored);
    }
  }

  return results;
}
