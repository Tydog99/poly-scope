import type { Signal, SignalResult, Trade, SignalContext } from './types.js';

export class ConvictionSignal implements Signal {
  name = 'conviction';
  weight = 25;

  async calculate(trade: Trade, context: SignalContext): Promise<SignalResult> {
    const { config, accountHistory } = context;
    const { minPositionPercent } = config.conviction;

    // No history = assume high conviction (risky bet on unknown account)
    if (!accountHistory) {
      return {
        name: this.name,
        score: 100,
        weight: this.weight,
        details: { reason: 'no_history' },
      };
    }

    // Calculate what percentage of their historical volume this trade represents
    const totalVolume = accountHistory.totalVolumeUsd;
    const tradePercent = totalVolume > 0
      ? (trade.valueUsd / totalVolume) * 100
      : 100; // If no prior volume, treat as 100% conviction

    // Score based on how much of portfolio is concentrated in this bet
    let score = 0;
    if (tradePercent >= minPositionPercent) {
      score = 100;
    } else if (tradePercent >= minPositionPercent / 2) {
      // Linear scale from 50% threshold to 80% threshold
      score = ((tradePercent - minPositionPercent / 2) / (minPositionPercent / 2)) * 100;
    } else {
      // Below 40%, low conviction
      score = (tradePercent / (minPositionPercent / 2)) * 30;
    }

    return {
      name: this.name,
      score: Math.round(Math.min(100, score)),
      weight: this.weight,
      details: {
        tradeValueUsd: trade.valueUsd,
        totalVolumeUsd: totalVolume,
        tradePercent: Math.round(tradePercent * 10) / 10,
      },
    };
  }
}
