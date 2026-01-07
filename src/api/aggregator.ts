import type { SubgraphTrade, SubgraphPosition, AggregatedTrade, TradeFill } from './types.js';

export interface AggregationOptions {
  wallet: string;
  tokenToOutcome: Map<string, 'YES' | 'NO'>;
  walletPositions?: SubgraphPosition[];
}

export function aggregateFills(
  fills: SubgraphTrade[],
  options: AggregationOptions
): AggregatedTrade[] {
  const { wallet, tokenToOutcome } = options;
  const walletLower = wallet.toLowerCase();

  // Group fills by transactionHash + outcome
  const groups = new Map<string, SubgraphTrade[]>();

  for (const fill of fills) {
    const txHash = fill.transactionHash;
    const outcome = tokenToOutcome.get(fill.marketId.toLowerCase()) ?? 'YES';
    const key = `${txHash}|${outcome}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(fill);
  }

  // Convert each group to AggregatedTrade
  const result: AggregatedTrade[] = [];

  for (const [key, groupFills] of groups) {
    const [txHash, outcome] = key.split('|') as [string, 'YES' | 'NO'];
    const firstFill = groupFills[0];

    // Determine wallet's role and side
    const isMaker = firstFill.maker.toLowerCase() === walletLower;
    const role: 'maker' | 'taker' = isMaker ? 'maker' : 'taker';
    // Maker's side matches field; taker's side is opposite
    const side: 'BUY' | 'SELL' = isMaker
      ? (firstFill.side === 'Buy' ? 'BUY' : 'SELL')
      : (firstFill.side === 'Buy' ? 'SELL' : 'BUY');

    // Aggregate values
    let totalValueUsd = 0;
    let totalSize = 0;
    let earliestTimestamp = Infinity;
    const tradeFills: TradeFill[] = [];

    for (const fill of groupFills) {
      const valueUsd = parseFloat(fill.size) / 1e6;
      const price = parseFloat(fill.price);
      const size = price > 0 ? valueUsd / price : 0;

      totalValueUsd += valueUsd;
      totalSize += size;
      earliestTimestamp = Math.min(earliestTimestamp, fill.timestamp);

      tradeFills.push({
        id: fill.id,
        size,
        price,
        valueUsd,
        timestamp: fill.timestamp,
        maker: fill.maker,
        taker: fill.taker,
        role,
      });
    }

    // Weighted average price
    const avgPrice = totalSize > 0 ? totalValueUsd / totalSize : 0;

    result.push({
      transactionHash: txHash,
      marketId: firstFill.marketId,
      wallet: walletLower,
      side,
      outcome,
      totalSize,
      totalValueUsd,
      avgPrice,
      timestamp: new Date(earliestTimestamp * 1000),
      fills: tradeFills,
      fillCount: tradeFills.length,
    });
  }

  // Sort by timestamp descending
  result.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return result;
}
