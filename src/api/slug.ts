import type { GammaEvent } from './types.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';

export interface ResolvedMarket {
  conditionId: string;
  question: string;
  slug: string;
}

export class SlugResolver {
  async resolve(slugOrConditionId: string): Promise<ResolvedMarket[]> {
    // If it looks like a condition ID (0x...), return as-is
    if (slugOrConditionId.startsWith('0x')) {
      return [{
        conditionId: slugOrConditionId,
        question: slugOrConditionId,
        slug: slugOrConditionId,
      }];
    }

    // Otherwise treat as slug and fetch from Gamma API
    const url = `${GAMMA_API}/events/slug/${slugOrConditionId}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to resolve slug "${slugOrConditionId}": ${response.statusText}`);
    }

    const event = await response.json() as GammaEvent;

    if (!event.markets || event.markets.length === 0) {
      throw new Error(`No markets found for slug "${slugOrConditionId}"`);
    }

    return event.markets.map(m => ({
      conditionId: m.conditionId,
      question: m.question,
      slug: event.slug,
    }));
  }
}
