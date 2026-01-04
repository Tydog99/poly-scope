import { ClobClient, Chain } from '@polymarket/clob-client';
import type { Market, MarketToken } from './types.js';

const CLOB_HOST = 'https://clob.polymarket.com';

interface ClobToken {
  token_id: string;
  outcome: string;
  price?: number;
}

export class PolymarketClient {
  private clob: ClobClient;
  readonly host = CLOB_HOST;

  constructor() {
    this.clob = new ClobClient(CLOB_HOST, Chain.POLYGON);
  }

  async getMarket(conditionId: string): Promise<Market> {
    const raw = await this.clob.getMarket(conditionId);

    // Extract token IDs
    const tokens: MarketToken[] = (raw.tokens as ClobToken[] ?? []).map((t) => ({
      tokenId: t.token_id,
      outcome: t.outcome as 'Yes' | 'No',
      price: t.price,
    }));

    return {
      conditionId: raw.condition_id,
      questionId: raw.question_id ?? '',
      question: raw.question,
      outcomes: tokens.map((t) => t.outcome),
      tokens,
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
