import type { Market, SubgraphTrade } from '../api/types.js';
import type { ResolvedToken } from '../api/market-resolver.js';
import type { Trade, SignalContext, SignalResult } from '../signals/types.js';
import type { SuspiciousTrade } from '../output/types.js';
import { aggregateFills } from '../api/aggregator.js';
import type { Signal } from '../signals/types.js';
import type { SignalAggregator } from '../signals/aggregator.js';
import type { TradeDB } from '../db/index.js';

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
 * Groups fills by wallet (both maker and taker roles), then aggregates each wallet's fills.
 *
 * IMPORTANT: Each fill is added to BOTH the maker's and taker's groups because:
 * 1. In CLOB cross-matching, a wallet's YES buy order can trigger NO fills for counterparties
 * 2. The wallet appears as maker on YES (their order) and taker on NO (counterparty appearance)
 * 3. aggregateFills() handles role-based complementary filtering to keep the correct side
 */
export function aggregateFillsPerWallet(
  fills: SubgraphTrade[],
  tokenToOutcome: Map<string, 'YES' | 'NO'>
): Trade[] {
  // Group fills by wallet (includes both maker and taker roles)
  const fillsByWallet = new Map<string, SubgraphTrade[]>();

  for (const fill of fills) {
    // Add fill to maker's group
    const maker = fill.maker?.toLowerCase();
    if (maker) {
      if (!fillsByWallet.has(maker)) {
        fillsByWallet.set(maker, []);
      }
      fillsByWallet.get(maker)!.push(fill);
    }

    // Add fill to taker's group
    const taker = fill.taker?.toLowerCase();
    if (taker) {
      if (!fillsByWallet.has(taker)) {
        fillsByWallet.set(taker, []);
      }
      fillsByWallet.get(taker)!.push(fill);
    }
  }

  // Aggregate each wallet's fills
  // aggregateFills() handles:
  // - Role detection (maker vs taker per fill)
  // - Side inversion for takers
  // - Complementary trade filtering (prefers maker role when no position data)
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
  context: SignalContext,
  tradeDb?: TradeDB
): Promise<SuspiciousTrade | null> {
  // Get point-in-time historical state from DB if available
  let historicalState = context.historicalState;
  if (tradeDb && !historicalState) {
    const tradeTimestamp = Math.floor(trade.timestamp.getTime() / 1000);
    historicalState = tradeDb.getAccountStateAt(trade.wallet, tradeTimestamp);
  }

  const fullContext: SignalContext = {
    ...context,
    historicalState,
  };

  const results = await Promise.all(
    signals.map(s => s.calculate(trade, fullContext))
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
    tradeDb?: TradeDB;
  }
): Promise<SuspiciousTrade[]> {
  const { onProgress, progressInterval = 500, tradeDb } = options ?? {};
  const results: SuspiciousTrade[] = [];

  for (let i = 0; i < trades.length; i++) {
    if (onProgress && (i + 1) % progressInterval === 0) {
      onProgress(i + 1, trades.length);
    }

    const scored = await scoreTrade(trades[i], signals, aggregator, context, tradeDb);
    if (scored) {
      results.push(scored);
    }
  }

  return results;
}
