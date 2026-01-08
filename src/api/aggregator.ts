import type { SubgraphTrade, SubgraphPosition, AggregatedTrade, TradeFill } from './types.js';

export interface AggregationOptions {
  wallet: string;
  tokenToOutcome: Map<string, 'YES' | 'NO'>;
  walletPositions?: SubgraphPosition[];
}

interface FillGroup {
  txHash: string;
  outcome: 'YES' | 'NO';
  role: 'maker' | 'taker';
  fills: SubgraphTrade[];
  totalValueUsd: number;
}

export function aggregateFills(
  fills: SubgraphTrade[],
  options: AggregationOptions
): AggregatedTrade[] {
  const { wallet, tokenToOutcome, walletPositions = [] } = options;
  const walletLower = wallet.toLowerCase();

  // Step 1: Group fills by transactionHash + outcome + role
  // This prevents double-counting when wallet is both maker and taker in same tx
  const groups = new Map<string, FillGroup>();

  for (const fill of fills) {
    const txHash = fill.transactionHash;
    const outcome = tokenToOutcome.get(fill.marketId.toLowerCase()) ?? 'YES';
    const isMaker = fill.maker.toLowerCase() === walletLower;
    const role: 'maker' | 'taker' = isMaker ? 'maker' : 'taker';
    const key = `${txHash}|${outcome}|${role}`;
    const valueUsd = parseFloat(fill.size) / 1e6;

    if (!groups.has(key)) {
      groups.set(key, { txHash, outcome, role, fills: [], totalValueUsd: 0 });
    }
    const group = groups.get(key)!;
    group.fills.push(fill);
    group.totalValueUsd += valueUsd;
  }

  // Step 1b: Per tx+outcome, keep only the role with higher USD value
  // This handles cases where wallet appears as both maker and taker in same tx
  const txOutcomeGroups = new Map<string, FillGroup[]>();
  for (const group of groups.values()) {
    const key = `${group.txHash}|${group.outcome}`;
    if (!txOutcomeGroups.has(key)) {
      txOutcomeGroups.set(key, []);
    }
    txOutcomeGroups.get(key)!.push(group);
  }

  // Filter to keep only the primary role per tx+outcome
  const filteredGroups: FillGroup[] = [];
  for (const roleGroups of txOutcomeGroups.values()) {
    if (roleGroups.length === 1) {
      filteredGroups.push(roleGroups[0]);
    } else {
      // Pick the role with higher USD value (the "primary" trade)
      const sorted = roleGroups.sort((a, b) => b.totalValueUsd - a.totalValueUsd);
      filteredGroups.push(sorted[0]);
    }
  }

  // Step 2: Detect complementary trades per transaction
  // Group by txHash to find txs with both YES and NO
  const txToGroups = new Map<string, FillGroup[]>();
  for (const group of filteredGroups) {
    if (!txToGroups.has(group.txHash)) {
      txToGroups.set(group.txHash, []);
    }
    txToGroups.get(group.txHash)!.push(group);
  }

  // Determine wallet positions for YES/NO tokens
  const hasYesPosition = walletPositions.some(p => {
    const outcome = tokenToOutcome.get(p.marketId.toLowerCase());
    return outcome === 'YES' && parseFloat(p.netQuantity) > 0;
  });
  const hasNoPosition = walletPositions.some(p => {
    const outcome = tokenToOutcome.get(p.marketId.toLowerCase());
    return outcome === 'NO' && parseFloat(p.netQuantity) > 0;
  });

  // Step 3: Build result, filtering complementary
  const result: AggregatedTrade[] = [];

  for (const [txHash, txGroups] of txToGroups) {
    let complementaryOutcome: 'YES' | 'NO' | null = null;
    let complementaryValueUsd = 0;

    // Check if tx has both YES and NO
    if (txGroups.length === 2) {
      const yesGroup = txGroups.find(g => g.outcome === 'YES');
      const noGroup = txGroups.find(g => g.outcome === 'NO');

      if (yesGroup && noGroup) {
        // Determine which is complementary
        if (hasYesPosition && !hasNoPosition) {
          complementaryOutcome = 'NO';
          complementaryValueUsd = noGroup.totalValueUsd;
        } else if (hasNoPosition && !hasYesPosition) {
          complementaryOutcome = 'YES';
          complementaryValueUsd = yesGroup.totalValueUsd;
        } else {
          // Fall back to smaller value
          if (yesGroup.totalValueUsd <= noGroup.totalValueUsd) {
            complementaryOutcome = 'YES';
            complementaryValueUsd = yesGroup.totalValueUsd;
          } else {
            complementaryOutcome = 'NO';
            complementaryValueUsd = noGroup.totalValueUsd;
          }
        }
      }
    }

    // Convert non-complementary groups to AggregatedTrade
    for (const group of txGroups) {
      if (group.outcome === complementaryOutcome) {
        continue; // Skip complementary
      }

      const firstFill = group.fills[0];
      const role = group.role;
      const isMaker = role === 'maker';
      const side: 'BUY' | 'SELL' = isMaker
        ? (firstFill.side === 'Buy' ? 'BUY' : 'SELL')
        : (firstFill.side === 'Buy' ? 'SELL' : 'BUY');

      let totalValueUsd = 0;
      let totalSize = 0;
      let earliestTimestamp = Infinity;
      const tradeFills: TradeFill[] = [];

      for (const fill of group.fills) {
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

      const avgPrice = totalSize > 0 ? totalValueUsd / totalSize : 0;

      result.push({
        transactionHash: txHash,
        marketId: firstFill.marketId,
        wallet: walletLower,
        side,
        outcome: group.outcome,
        totalSize,
        totalValueUsd,
        avgPrice,
        timestamp: new Date(earliestTimestamp * 1000),
        fills: tradeFills,
        fillCount: tradeFills.length,
        hadComplementaryFills: complementaryOutcome !== null,
        complementaryValueUsd: complementaryOutcome !== null ? complementaryValueUsd : undefined,
      });
    }
  }

  // Sort by timestamp descending
  result.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return result;
}
