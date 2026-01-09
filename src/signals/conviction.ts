import type { Signal, SignalResult, SignalContext } from './types.js';
import type { AggregatedTrade } from '../api/types.js';

export class ConvictionSignal implements Signal {
  name = 'conviction';
  weight = 25;

  async calculate(trade: AggregatedTrade, context: SignalContext): Promise<SignalResult> {
    const { accountHistory, historicalState } = context;

    // Use historical state if available, otherwise fall back to current
    const priorVolume = historicalState
      ? historicalState.volume / 1e6 // Convert from scaled integer
      : (accountHistory?.totalVolumeUsd ?? 0);

    // If no volume history, can't calculate conviction
    if (priorVolume === 0 && (!accountHistory || accountHistory.totalVolumeUsd === 0)) {
      // New wallet with no history - high conviction by default
      return {
        name: this.name,
        score: 80,
        weight: this.weight,
        details: {
          reason: 'no_history',
          tradeValueUsd: trade.totalValueUsd,
        },
      };
    }

    // Calculate what percentage of their total volume this trade represents
    const effectiveVolume = priorVolume > 0 ? priorVolume : (accountHistory?.totalVolumeUsd ?? 1);
    const concentration = (trade.totalValueUsd / effectiveVolume) * 100;

    // Score based on concentration
    // 50%+ of volume in one trade = max score
    // 10% = medium score
    // <5% = low score
    let score: number;
    if (concentration >= 50) {
      score = 100;
    } else if (concentration >= 25) {
      score = 70 + (concentration - 25) * 1.2; // 70-100
    } else if (concentration >= 10) {
      score = 40 + (concentration - 10) * 2; // 40-70
    } else if (concentration >= 5) {
      score = 20 + (concentration - 5) * 4; // 20-40
    } else {
      score = concentration * 4; // 0-20
    }

    return {
      name: this.name,
      score: Math.round(Math.min(100, score)),
      weight: this.weight,
      details: {
        tradeValueUsd: trade.totalValueUsd,
        totalVolumeUsd: effectiveVolume,
        concentrationPercent: Math.round(concentration * 10) / 10,
        ...(historicalState && { usingHistoricalState: true }),
      },
    };
  }
}
