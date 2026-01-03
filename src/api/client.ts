import { ClobClient, Chain } from '@polymarket/clob-client';
import type { Market } from './types.js';

const CLOB_HOST = 'https://clob.polymarket.com';

export class PolymarketClient {
  private clob: ClobClient;
  readonly host = CLOB_HOST;

  constructor() {
    this.clob = new ClobClient(CLOB_HOST, Chain.POLYGON);
  }

  async getMarket(conditionId: string): Promise<Market> {
    const raw = await this.clob.getMarket(conditionId);

    return {
      conditionId: raw.condition_id,
      questionId: raw.question_id ?? '',
      question: raw.question,
      outcomes: raw.tokens?.map((t: { outcome: string }) => t.outcome) ?? ['Yes', 'No'],
      resolutionSource: raw.resolution_source ?? '',
      endDate: raw.end_date_iso ?? '',
      resolved: raw.closed ?? false,
      winningOutcome: raw.winning_outcome,
    };
  }

  getClobClient(): ClobClient {
    return this.clob;
  }
}
