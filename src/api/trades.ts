import type { Trade } from '../signals/types.js';

const DATA_API = 'https://data-api.polymarket.com';

interface DataApiTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  timestamp: number;
  conditionId: string;
  outcome: string;
  transactionHash: string;
}

export class TradeFetcher {
  async getTradesForMarket(
    marketId: string,
    options: {
      after?: Date;
      before?: Date;
      outcome?: 'YES' | 'NO';
    } = {}
  ): Promise<Trade[]> {
    const allTrades: Trade[] = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
      const url = new URL(`${DATA_API}/trades`);
      url.searchParams.set('market', marketId);
      url.searchParams.set('limit', limit.toString());
      url.searchParams.set('offset', offset.toString());

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Failed to fetch trades: ${response.statusText}`);
      }

      const rawTrades = await response.json() as DataApiTrade[];

      if (rawTrades.length === 0) break;

      for (const raw of rawTrades) {
        const trade = this.convertTrade(raw, marketId);

        // Apply filters
        if (options.after && trade.timestamp < options.after) continue;
        if (options.before && trade.timestamp > options.before) continue;
        if (options.outcome && trade.outcome !== options.outcome) continue;

        allTrades.push(trade);
      }

      if (rawTrades.length < limit) break;
      offset += limit;
    }

    return allTrades;
  }

  private convertTrade(raw: DataApiTrade, marketId: string): Trade {
    const size = parseFloat(raw.size);
    const price = parseFloat(raw.price);

    return {
      id: raw.transactionHash,
      marketId,
      wallet: raw.proxyWallet,
      side: raw.side,
      outcome: raw.outcome.toUpperCase() as 'YES' | 'NO',
      size,
      price,
      timestamp: new Date(raw.timestamp),
      valueUsd: size * price,
    };
  }
}
