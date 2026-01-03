import type { Signal, SignalResult, Trade, SignalContext } from './types.js';

export class AccountHistorySignal implements Signal {
  name = 'accountHistory';
  weight = 35;

  async calculate(trade: Trade, context: SignalContext): Promise<SignalResult> {
    const { config, accountHistory } = context;
    const { maxLifetimeTrades, maxAccountAgeDays, minDormancyDays } = config.accountHistory;

    // No history = maximum suspicion
    if (!accountHistory || !accountHistory.firstTradeDate) {
      return {
        name: this.name,
        score: 100,
        weight: this.weight,
        details: { reason: 'no_history' },
      };
    }

    const now = new Date();
    const accountAgeDays = Math.floor(
      (now.getTime() - accountHistory.firstTradeDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    const dormancyDays = accountHistory.lastTradeDate
      ? Math.floor(
          (trade.timestamp.getTime() - accountHistory.lastTradeDate.getTime()) / (1000 * 60 * 60 * 24)
        )
      : 0;

    // Calculate component scores (each 0-33)
    const tradeCountScore = this.scoreTradeCount(accountHistory.totalTrades, maxLifetimeTrades);
    const ageScore = this.scoreAccountAge(accountAgeDays, maxAccountAgeDays);
    const dormancyScore = this.scoreDormancy(dormancyDays, minDormancyDays);

    const totalScore = Math.round(tradeCountScore + ageScore + dormancyScore);

    return {
      name: this.name,
      score: Math.min(100, totalScore),
      weight: this.weight,
      details: {
        totalTrades: accountHistory.totalTrades,
        accountAgeDays,
        dormancyDays,
        tradeCountScore: Math.round(tradeCountScore),
        ageScore: Math.round(ageScore),
        dormancyScore: Math.round(dormancyScore),
      },
    };
  }

  private scoreTradeCount(count: number, threshold: number): number {
    if (count >= threshold * 10) return 0;
    if (count <= threshold) return 33;
    // Linear decay from threshold to threshold*10
    return 33 * (1 - (count - threshold) / (threshold * 9));
  }

  private scoreAccountAge(days: number, threshold: number): number {
    if (days >= threshold * 12) return 0; // Over a year
    if (days <= threshold) return 33;
    return 33 * (1 - (days - threshold) / (threshold * 11));
  }

  private scoreDormancy(days: number, threshold: number): number {
    if (days < threshold) return 0;
    // Score increases with dormancy, caps at 2x threshold
    const excess = days - threshold;
    return Math.min(34, (excess / threshold) * 34);
  }
}
