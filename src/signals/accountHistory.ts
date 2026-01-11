import type { Signal, SignalResult, SignalContext, AccountHistory } from './types.js';
import type { AggregatedTrade } from '../api/types.js';

export class AccountHistorySignal implements Signal {
  name = 'accountHistory';
  weight = 35;

  async calculate(trade: AggregatedTrade, context: SignalContext): Promise<SignalResult> {
    const { config, accountHistory, historicalState } = context;
    const { maxLifetimeTrades, maxAccountAgeDays, minDormancyDays } = config.accountHistory;

    // If account history was skipped due to budget, return neutral score (50)
    // rather than defaulting to maximum suspicion.
    if (accountHistory === undefined) {
      return {
        name: this.name,
        score: 50,
        weight: this.weight,
        details: { reason: 'skipped_budget' },
      };
    }

    // No history found = maximum suspicion (new account)
    if (!accountHistory || !accountHistory.firstTradeDate) {
      return {
        name: this.name,
        score: 100,
        weight: this.weight,
        details: { reason: 'no_history' },
      };
    }

    // Use historical state if available (point-in-time analysis), otherwise fall back to current
    const tradeCount = historicalState?.tradeCount ?? accountHistory.totalTrades;
    const usingHistoricalState = historicalState !== undefined;

    // Use creationDate from subgraph if available, otherwise fall back to firstTradeDate
    const accountCreationDate = accountHistory.creationDate || accountHistory.firstTradeDate;
    // Calculate account age relative to the trade timestamp, not current date
    // This ensures historical analysis correctly measures how old the account was at trade time
    const accountAgeDays = Math.floor(
      (trade.timestamp.getTime() - accountCreationDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    // Calculate dormancy using point-in-time lastTradeTimestamp if available
    let dormancyDays: number;
    if (usingHistoricalState) {
      // Point-in-time: use last trade before this one (from historicalState)
      if (historicalState.lastTradeTimestamp) {
        dormancyDays = Math.floor(
          (trade.timestamp.getTime() / 1000 - historicalState.lastTradeTimestamp) / (60 * 60 * 24)
        );
      } else {
        // No prior trades = first trade, no dormancy
        dormancyDays = 0;
      }
    } else {
      // Fallback to global lastTradeDate (may be inaccurate for historical analysis)
      dormancyDays = accountHistory.lastTradeDate
        ? Math.floor(
          (trade.timestamp.getTime() - accountHistory.lastTradeDate.getTime()) /
          (1000 * 60 * 60 * 24)
        )
        : 0;
    }

    // Calculate component scores
    // When we have profit data, use 4 components (each 0-25)
    // Otherwise use 3 components (each 0-33) for backward compatibility

    // Use point-in-time profit if available, otherwise fall back to global
    const profitUsd = usingHistoricalState
      ? historicalState.pnl / 1e6  // Point-in-time PnL (may be 0 if not calculated)
      : accountHistory.profitUsd;
    const volumeUsd = usingHistoricalState
      ? historicalState.volume / 1e6  // Point-in-time volume
      : accountHistory.totalVolumeUsd;

    const hasProfit = profitUsd !== undefined;

    let tradeCountScore: number;
    let ageScore: number;
    let dormancyScore: number;
    let profitScore = 0;

    if (hasProfit) {
      // 4-component scoring (each 0-25 max)
      tradeCountScore = this.scoreTradeCount(tradeCount, maxLifetimeTrades, 25);
      ageScore = this.scoreAccountAge(accountAgeDays, maxAccountAgeDays, 25);
      dormancyScore = this.scoreDormancy(dormancyDays, minDormancyDays, 25);
      profitScore = this.scoreProfitOnNewAccount(
        profitUsd,
        accountAgeDays,
        volumeUsd
      );
    } else {
      // 3-component scoring for backward compatibility
      tradeCountScore = this.scoreTradeCount(tradeCount, maxLifetimeTrades, 33);
      ageScore = this.scoreAccountAge(accountAgeDays, maxAccountAgeDays, 33);
      dormancyScore = this.scoreDormancy(dormancyDays, minDormancyDays, 34);

      // Even without profit, high volume on a very new account is suspicious.
      // If < 30 days old and > $10k volume, add volume bonus (caps at 25)
      if (accountAgeDays <= 30 && accountHistory.totalVolumeUsd > 10000) {
        const volumeBonus = Math.min(25, (accountHistory.totalVolumeUsd / 20000) * 25);
        // Normalize the 3-component total to fit with the bonus
        // Or just let it exceed slightly and cap at 100
        tradeCountScore = (tradeCountScore * 75) / 100;
        ageScore = (ageScore * 75) / 100;
        dormancyScore = (dormancyScore * 75) / 100;
        profitScore = volumeBonus;
      }
    }

    const totalScore = Math.round(tradeCountScore + ageScore + dormancyScore + profitScore);

    const details: Record<string, unknown> = {
      totalTrades: tradeCount,
      accountAgeDays,
      dormancyDays,
      tradeCountScore: Math.round(tradeCountScore),
      ageScore: Math.round(ageScore),
      dormancyScore: Math.round(dormancyScore),
      dataSource: accountHistory.dataSource || 'data-api',
    };

    // Indicate when historical state was used
    if (usingHistoricalState) {
      details.usingHistoricalState = true;
    }

    if (hasProfit) {
      details.profitUsd = profitUsd;  // Use point-in-time profit
      details.profitScore = Math.round(profitScore);
    }

    return {
      name: this.name,
      score: Math.min(100, totalScore),
      weight: this.weight,
      details,
    };
  }

  /**
   * Score based on trade count:
   * - 1 trade: 100% of maxScore (very suspicious - first trade)
   * - 2-5 trades: 90-70% of maxScore (still suspicious)
   * - 6-50 trades: linear decay from 70% to 0%
   * - 50+ trades: 0 (established trader)
   */
  private scoreTradeCount(count: number, _threshold: number, maxScore: number): number {
    if (count <= 0) return maxScore; // No trades = max suspicious
    if (count === 1) return maxScore; // First trade = max suspicious
    if (count <= 5) {
      // 2-5 trades: 90% down to 70% of maxScore
      return maxScore * (0.9 - (count - 2) * 0.05);
    }
    if (count >= 50) return 0; // Established trader
    // 6-50 trades: linear decay from 70% to 0%
    return maxScore * 0.7 * (1 - (count - 6) / 44);
  }

  private scoreAccountAge(days: number, threshold: number, maxScore: number): number {
    if (days >= threshold * 12) return 0; // Over a year
    if (days <= threshold) return maxScore;
    return maxScore * (1 - (days - threshold) / (threshold * 11));
  }

  private scoreDormancy(days: number, threshold: number, maxScore: number): number {
    if (days < threshold) return 0;
    // Score increases with dormancy, caps at 2x threshold
    const excess = days - threshold;
    return Math.min(maxScore, (excess / threshold) * maxScore);
  }

  /**
   * Score based on profit for new accounts.
   * Large profits on new accounts with few trades are suspicious.
   * Large losses are not suspicious (just bad luck/skill).
   */
  private scoreProfitOnNewAccount(
    profitUsd: number,
    accountAgeDays: number,
    volumeUsd: number
  ): number {
    const maxScore = 25;

    // Only suspicious if profit is positive and account is relatively new
    if (profitUsd <= 0 || accountAgeDays > 90) {
      return 0;
    }

    // Calculate profit rate (profit as percentage of volume)
    const profitRate = volumeUsd > 0 ? profitUsd / volumeUsd : 0;

    // High profit rate (>20%) on a new account (<30 days) is very suspicious
    // Suggests informed trading / insider knowledge
    if (accountAgeDays <= 30) {
      if (profitRate > 0.5) return maxScore; // >50% return in first month
      if (profitRate > 0.3) return maxScore * 0.8;
      if (profitRate > 0.2) return maxScore * 0.6;
      if (profitRate > 0.1) return maxScore * 0.4;
      if (profitUsd > 10000) return maxScore * 0.3; // Large absolute profit
    } else if (accountAgeDays <= 60) {
      if (profitRate > 0.5) return maxScore * 0.6;
      if (profitRate > 0.3) return maxScore * 0.4;
      if (profitRate > 0.2) return maxScore * 0.2;
    } else {
      // 60-90 days
      if (profitRate > 0.5) return maxScore * 0.3;
      if (profitRate > 0.3) return maxScore * 0.2;
    }

    return 0;
  }
}
