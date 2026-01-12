import type { Signal, SignalResult, SignalContext, PricePoint } from './types.js';
import type { AggregatedTrade } from '../api/types.js';

export class TradeSizeSignal implements Signal {
  name = 'tradeSize';
  weight = 40;

  async calculate(trade: AggregatedTrade, context: SignalContext): Promise<SignalResult> {
    const { config, marketPrices } = context;
    const tokenPrices = marketPrices?.get(trade.marketId) ?? [];
    const { minAbsoluteUsd, minImpactPercent, impactWindowMinutes } = config.tradeSize;

    // Check minimum threshold
    if (trade.totalValueUsd < minAbsoluteUsd) {
      return {
        name: this.name,
        score: 0,
        weight: this.weight,
        details: { reason: 'below_threshold', valueUsd: trade.totalValueUsd, minAbsoluteUsd },
      };
    }

    // Calculate size score (0-50 points) - scales logarithmically
    const sizeMultiple = trade.totalValueUsd / minAbsoluteUsd;
    const sizeScore = Math.min(50, Math.log10(sizeMultiple) * 25 + 25);

    // Calculate impact score (0-50 points)
    const impact = this.calculateImpact(trade, tokenPrices, impactWindowMinutes);
    const impactScore = impact >= minImpactPercent
      ? Math.min(50, (impact / minImpactPercent) * 25)
      : 0;

    const totalScore = Math.round(sizeScore + impactScore);

    return {
      name: this.name,
      score: Math.min(100, totalScore),
      weight: this.weight,
      details: {
        valueUsd: trade.totalValueUsd,
        sizeScore: Math.round(sizeScore),
        impactPercent: impact,
        impactScore: Math.round(impactScore),
        fillCount: trade.fillCount,
      },
    };
  }

  private calculateImpact(
    trade: AggregatedTrade,
    prices: PricePoint[],
    windowMinutes: number
  ): number {
    if (prices.length < 2) return 0;

    const tradeTime = trade.timestamp.getTime();
    const windowMs = windowMinutes * 60 * 1000;

    const before = prices
      .filter(p => p.timestamp.getTime() < tradeTime &&
                   p.timestamp.getTime() > tradeTime - windowMs)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

    const after = prices
      .filter(p => p.timestamp.getTime() > tradeTime &&
                   p.timestamp.getTime() < tradeTime + windowMs)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];

    if (!before || !after) return 0;

    const priceDiff = Math.abs(after.price - before.price);
    return (priceDiff / before.price) * 100;
  }
}
