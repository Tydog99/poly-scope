import type { Trade } from './types.js';
import type { Config } from '../config.js';
import type { AggregatedScore } from '../signals/types.js';
import type { SuspiciousTrade } from '../output/types.js';

export type TradeClassification = 'WHALE' | 'SNIPER' | 'EARLY_MOVER' | 'DUMPING';

export class TradeClassifier {
    constructor(private config: Config) { }

    classify(trade: SuspiciousTrade, scoreResult: AggregatedScore, marketCreatedAt?: Date): TradeClassification[] {
        const classifications: TradeClassification[] = [];
        const {
            whaleThreshold, sniperSizeMax, sniperImpactMin,
            sniperScoreMin, earlyWindowHours, dumpImpactMin
        } = this.config.classification;

        // WHALE: Large absolute size
        if (trade.trade.valueUsd >= whaleThreshold) {
            classifications.push('WHALE');
        }

        // SNIPER: High score + meaningful impact + not huge size
        const impact = trade.priceImpact?.changePercent || 0;

        // Check if it's a sniper
        if (
            trade.score.total >= sniperScoreMin &&
            Math.abs(impact) >= sniperImpactMin &&
            trade.trade.valueUsd < whaleThreshold // Whales aren't usually called snipers
        ) {
            classifications.push('SNIPER');
        }

        // DUMPING: Large price drop on sell
        if (
            trade.trade.side === 'SELL' &&
            impact <= -dumpImpactMin
        ) {
            classifications.push('DUMPING');
        }

        // EARLY MOVER: Trade within window of creation
        if (marketCreatedAt) {
            const diffMs = trade.trade.timestamp.getTime() - marketCreatedAt.getTime();
            const diffHours = diffMs / (1000 * 60 * 60);
            if (diffHours >= 0 && diffHours <= earlyWindowHours) {
                classifications.push('EARLY_MOVER');
            }
        }

        return classifications;
    }
}
