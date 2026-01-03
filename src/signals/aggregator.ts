import type { Config } from '../config.js';
import type { SignalResult, AggregatedScore } from './types.js';

export class SignalAggregator {
  constructor(private config: Config) {}

  aggregate(signals: SignalResult[]): AggregatedScore {
    const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);

    const weightedSum = signals.reduce((sum, signal) => {
      return sum + (signal.score * signal.weight);
    }, 0);

    const total = Math.round(weightedSum / totalWeight);

    return {
      total,
      signals,
      isAlert: total >= this.config.alertThreshold,
    };
  }
}
