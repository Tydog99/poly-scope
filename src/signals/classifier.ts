import type { Trade } from './types.js';
import type { AggregatedScore } from '../signals/types.js';
import type { SuspiciousTrade } from '../output/types.js';

export type TradeClassification = 'WHALE' | 'SNIPER' | 'EARLY_MOVER' | 'DUMPING';

export class TradeClassifier {
    classify(trade: SuspiciousTrade, scoreResult: AggregatedScore, marketCreatedAt?: Date): TradeClassification[] {
        const classifications: TradeClassification[] = [];

        // Configurable thresholds (could be moved to config)
        const WHALE_THRESHOLD = 25000;
        const SNIPER_SIZE_MAX = 10000;
        const SNIPER_IMPACT_MIN = 2.0;
        const SNIPER_SCORE_MIN = 80;
        const EARLY_WINDOW_HOURS = 48;
        const DUMP_IMPACT_MIN = 5.0;

        // WHALE: Large absolute size
        if (trade.trade.valueUsd >= WHALE_THRESHOLD) {
            classifications.push('WHALE');
        }

        // SNIPER: High score + meaningful impact + not huge size
        // Using trade size signal details for impact if available
        const impact = trade.priceImpact?.changePercent || 0;

        // Check if it's a sniper
        if (
            trade.score.total >= SNIPER_SCORE_MIN &&
            Math.abs(impact) >= SNIPER_IMPACT_MIN &&
            trade.trade.valueUsd < WHALE_THRESHOLD // Whales aren't usually called snipers
        ) {
            classifications.push('SNIPER');
        }

        // DUMPING: Large price drop on sell
        if (
            trade.trade.side === 'SELL' &&
            impact <= -DUMP_IMPACT_MIN
        ) {
            classifications.push('DUMPING');
        }

        // EARLY MOVER: Trade within 48h of creation
        if (marketCreatedAt) {
            const diffMs = trade.trade.timestamp.getTime() - marketCreatedAt.getTime();
            const diffHours = diffMs / (1000 * 60 * 60);
            if (diffHours >= 0 && diffHours <= EARLY_WINDOW_HOURS) {
                classifications.push('EARLY_MOVER');
            }
        }

        return classifications;
    }
}
